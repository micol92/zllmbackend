const cds = require('@sap/cds');
const { DELETE } = cds.ql;
const sf_connection_util = require("./sf-connection-util")
const { handleMemoryBeforeRagCall, handleMemoryAfterRagCall } = require('./memory-helper');

// === LLM Config Definitions ===
const embeddingConfig = {
    destinationName: cds.env.requires["GENERATIVE_AI_HUB"].EMBEDDING_MODEL_DESTINATION_NAME,
    deploymentUrl: cds.env.requires["GENERATIVE_AI_HUB"].EMBEDDING_MODEL_DEPLOYMENT_URL,
    resourceGroup: cds.env.requires["GENERATIVE_AI_HUB"].EMBEDDING_MODEL_RESOURCE_GROUP,
    modelName: cds.env.requires["GENERATIVE_AI_HUB"].EMBEDDING_MODEL_NAME,
    apiVersion: cds.env.requires["GENERATIVE_AI_HUB"].EMBEDDING_MODEL_API_VERSION
};

const chatConfig = {
    destinationName: cds.env.requires["GENERATIVE_AI_HUB"].CHAT_MODEL_DESTINATION_NAME,
    deploymentUrl: cds.env.requires["GENERATIVE_AI_HUB"].CHAT_MODEL_DEPLOYMENT_URL,
    resourceGroup: cds.env.requires["GENERATIVE_AI_HUB"].CHAT_MODEL_RESOURCE_GROUP,
    modelName: cds.env.requires["GENERATIVE_AI_HUB"].CHAT_MODEL_NAME,
    apiVersion: cds.env.requires["GENERATIVE_AI_HUB"].CHAT_MODEL_API_VERSION
};
// === End LLM Config Definitions ===

userId = cds.env.requires["SUCCESS_FACTORS_CREDENTIALS"]["USER_ID"]

const tableName = 'SAP_DEMO_LLM_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';

const systemPrompt =
    `Your task is to classify the user question into either of the two categories: leave-request-query or generic-query\n

 If the user wants to take or apply leave with a timeline or time information , return the response as json with the following format:
 {
    "category" : "leave-request-query"
    "dates" : "yyyy/mm/dd-yyyy/mm/dd"
 } 

 For all other queries, return the response as json as follows
 {
    "category" : "generic-query"
 } 

Rules:

1. If the user does not provide any time information consider it as a generic category.
2. If the category of the user question is "leave-request-query", 
a. if the user does not input exact dates and only mentions months, fill the dates as "[start date of the month]-[end date of the month]".
b. if the user does not input exact dates and only mentions week, fill the dates as "[start date of the week]-[end date of the week]".

EXAMPLES:

EXAMPLE1: 

user input: Can I take leave between January 1 to January 10 ?
response:  {
    "category" : "leave-request-query"
    "dates" : "2024/01/01-2024/01/10"
 } 

EXAMPLE2: 

user input: What is the maternity leave policy ?
response:  {
    "category" : "generic-query"
 } 

EXAMPLE3: 

user input:  Can I take leave in March ?
response:  {
    "category" : "leave-request-query"
    "dates" : "2024/03/01-2024/03/31"
 } 

EXAMPLE4: 

user input:  Can I take leave this week ?
response:  {
    "category" : "leave-request-query"
    "dates" : "2024/02/26-2024/03/01"
 } 

EXAMPLE5: 

 user input:  Can I take leave next week ?
 response:  {
     "category" : "leave-request-query"
     "dates" : "2024/03/04-2024/03/08"
  } 

EXAMPLE6:
user input: Can I take leave ?
response: {
    "category" : "generic-query"
 } 

`;

const hrRequestPrompt =
    `You are a chatbot. Answer the user question based on the following information
1. HR policy, delimited by triple backticks. \n 
2. If there are any team specific leave guidelines in the HR policy, consider the user as member of the following team and check the team members leave schedule in json format delimited by double backticks.

Team Member Leave Schedule\n

{ "name" : [[ leave_start_date - leave_end_date]] }\n

Rules: \n 
1. Ask follow up questions if you need additional information from user to answer the question.\n 
2. If the team members leave schedule is {} or empty , then none of the team members are on leave.\n
3. Be more formal in your response. \n
4. Keep the answers concise. 
`
    ;

const genericRequestPrompt =
    'You are a chatbot. Answer the user question based only on the context, delimited by triple backticks\n ';
;

const taskCategory = {
    "leave-request-query": hrRequestPrompt,
    "generic-query": genericRequestPrompt
}

function getFormattedDate(timeStamp) {
    const timestamp = Number(timeStamp);
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'GMT',
    }).format(date);
}

// srv/chat-service.js (상단 util 영역에 추가)
function extractAssistantText(resp, providerHint) {
    // GPT (Azure OpenAI / OpenAI ChatCompletions)
    if (resp?.choices?.[0]?.message?.content) {
        return resp.choices[0].message.content;
    }

    // Claude (Bedrock 등)
    // 예: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(resp?.content) && resp.content[0]?.text) {
        return resp.content.map(p => p.text).join("\n");
    }
    if (Array.isArray(resp?.output) && resp.output[0]?.content?.[0]?.text) {
        // 일부 Bedrock SDK 포맷
        return resp.output.map(o => o.content?.[0]?.text).join("\n");
    }

    // Gemini
    // 예: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
    const partText =
        resp?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("\n");
    if (partText) return partText;

    // 혹시 provider 별 힌트를 사용한다면(선택)
    if (providerHint === "gpt" && resp?.id && resp?.choices) {
        return resp?.choices?.[0]?.message?.content ?? null;
    }

    return null; // 못 찾음
}

function parseJsonOrThrow(text, rawRespForDebug) {
    if (typeof text !== "string") {
        const preview = JSON.stringify(rawRespForDebug)?.slice(0, 500);
        throw new Error(`LLM response has no text content to parse. Raw preview: ${preview}`);
    }
    // JSON 이라고 가정하고 오면 따옴표/백틱으로 감싼 경우도 있어 방어적으로 트림
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch (e) {
        // 모델이 코드블록 ```json … ``` 으로 감싼 경우 제거 시도
        const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (m && m[1]) {
            return JSON.parse(m[1]);
        }
        // 더 이상 못 고치면 원문 남기고 에러
        const preview = trimmed.slice(0, 500);
        const err = new Error(`Failed to parse JSON from LLM text. Preview: ${preview}`);
        err.cause = e;
        throw err;
    }
}

// 허용되는 role만 통과, content가 비어있거나 null인 항목 제거
function sanitizeContext(ctx) {
    const ALLOWED = new Set(["system", "assistant", "user", "function", "tool", "developer"]);
    if (!Array.isArray(ctx)) return [];

    const cleaned = [];
    for (const m of ctx) {
        if (!m || typeof m !== "object") continue;

        let { role, content } = m;

        // 일부 저장 포맷이 {role:"model"} 또는 {role:"ai"} 일 수 있어 보정
        if (role === "model" || role === "ai") role = "assistant";

        if (!ALLOWED.has(role)) continue;
        if (typeof content !== "string") continue;

        const trimmed = content.trim();
        if (!trimmed) continue;

        cleaned.push({ role, content: trimmed });
    }
    return cleaned;
}


module.exports = function () {

    this.on('getChatRagResponse', async (req) => {
        try {
            //request input data
            const { conversationId, messageId, message_time, user_id, user_query } = req.data;

            const { Conversation, Message } = this.entities;
            const vectorplugin = await cds.connect.to("cap-llm-plugin");
            console.log("====>>>>>[getChatRagResponse] req.data.conversatinoId :" + conversationId);
            console.log("====>>>>>[getChatRagResponse] req.data.messageId :" + messageId);
            console.log("====>>>>>[getChatRagResponse] req.data.message_time :" + message_time);
            console.log("====>>>>>[getChatRagResponse] req.data.user_id :" + user_id);
            console.log("====>>>>>[getChatRagResponse] req.data.user_query :" + user_query);

            
            let hrLeavePrompt = "";

            let determinationPayload = [{
                "role": "system",
                "content": `${systemPrompt}`
            }];

            const userQuestion = [
                {
                    "role": "user",
                    "content": `${user_query}`
                }
            ]

            determinationPayload.push(...userQuestion);
            let payload = {
                "messages": determinationPayload
            };

            //const determinationResponse = await vectorplugin.getChatCompletion(payload)
            //const determinationResponse = await vectorplugin.getChatCompletionWithConfig(chatConfig, payload)
            //const determinationJson = JSON.parse(determinationResponse.content);

            const determinationResponse = await vectorplugin.getChatCompletionWithConfig(chatConfig, payload);
            const determinationText = extractAssistantText(determinationResponse);

            if (!determinationText) {
                console.error("LLM raw response (truncated):", JSON.stringify(determinationResponse)?.slice(0, 2000));
                throw new Error("LLM returned no text content. See server logs for raw response.");
            }
            const determinationJson = parseJsonOrThrow(determinationText, determinationResponse);

            const category = determinationJson?.category;

            if (!taskCategory.hasOwnProperty(category)) {
                throw new Error(`${category} is not in the supported`);
            }
            console.log("====>>>>>[getChatRagResponse] category==leave-request-query before:" + category);

            //handle memory before the RAG LLM call
            console.log("====>>>>>[getChatRagResponse] handleMemoryBeforeRagCall:1:conversatinoId :" + conversationId);

            const memoryContext = await handleMemoryBeforeRagCall(conversationId, messageId, message_time, user_id, user_query, Conversation, Message);

            console.log("====>>>>>[getChatRagResponse] handleMemoryBeforeRagCall:2:conversatinoId :" + conversationId);

            // 여기서 한 번 정리
            const safeContext = sanitizeContext(memoryContext);

            /*Single method to perform the following :
            - Embed the input query
            - Perform similarity search based on the user query 
            - Construct the prompt based on the system instruction and similarity search
            - Call chat completion model to retrieve relevant answer to the user query
            */

            const promptCategory = {
                "leave-request-query": hrLeavePrompt,
                "generic-query": genericRequestPrompt
            }
            /*
                        const chatRagResponse = await vectorplugin.getRagResponse(
                            user_query,
                            tableName,
                            embeddingColumn,
                            contentColumn,
                            promptCategory[category] ,
                            memoryContext .length > 0 ? memoryContext : undefined,
                            30
                        );
            */
            console.log("====>>>>>zzzzzzz run getRagResponseWithConfig :");
            /*
                        const chatRagResponse = await vectorplugin.getRagResponseWithConfig(
                            user_query,
                            tableName,
                            embeddingColumn,
                            contentColumn,
                            promptCategory[category],
                            embeddingConfig,
                            chatConfig,
                            memoryContext.length > 0 ? memoryContext : undefined,
                            30,
                        );
            */
            console.log("====>>>>>zzzzzzz run safeContext :" + safeContext);


            const chatRagResponse = await vectorplugin.getRagResponseWithConfig(
                user_query,
                tableName,
                embeddingColumn,
                contentColumn,
                promptCategory[category],
                embeddingConfig,
                chatConfig,
                safeContext.length > 0 ? safeContext : undefined,
                30
            );
            console.log("[RAG raw completion preview]:",
                JSON.stringify(chatRagResponse?.completion)?.slice(0, 10000));
           // console.log("[RAG raw completion preview2]:",
            //    JSON.stringify(chatRagResponse?.completion));
            //handle memory after the RAG LLM call
            /*
            const responseTimestamp = new Date().toISOString();
            await handleMemoryAfterRagCall(conversationId, responseTimestamp, chatRagResponse.completion, Message, Conversation);

            console.log("====>>>>>nnn addtionConts :", chatRagResponse.additionalContents);
            const response = {
                "role": chatRagResponse.completion.role,
                "content": chatRagResponse.completion.content,
                "messageTime": responseTimestamp,
                "additionalContents": chatRagResponse.additionalContents,
            };
            return response;

            */

           

            /* 0825.for citation을 위해서. original part */
            
                        // 1) 모델 원시 응답에서 텍스트 추출
                        const assistantText = extractAssistantText(chatRagResponse.completion, "gpt"); // gpt/claude/gemini에 맞게 힌트 가능
            
                        console.log("====>>>>>nnn assistantText :", assistantText);

                        if (!assistantText) {
                            console.error("[RAG] No assistant text. Raw (truncated):",
                                JSON.stringify(chatRagResponse.completion)?.slice(0, 2000));
                            throw new Error("LLM returned no text content for RAG response.");
                        }
            
                        // 2) 메모리에도 '텍스트'만 저장 (원시 전체 응답 저장 X)
                        const responseTimestamp = new Date().toISOString();
                        await handleMemoryAfterRagCall(
                            conversationId,
                            responseTimestamp,
                            { role: "assistant", content: assistantText }, // 여기!
                            Message,
                            Conversation
                        );
            
                        // 3) 클라이언트로도 role/content를 표준 형태로 내려주기
                        console.log("====>>>>>nnn addtionConts :", chatRagResponse.additionalContents);
                        return {
                            role: "assistant",
                            content: assistantText,
                            messageTime: responseTimestamp,
                            additionalContents: chatRagResponse.additionalContents ?? [],
                        };

        }
        catch (error) {
            // Handle any errors that occur during the execution
            console.log('Error while generating response for user query:', error);
            throw error;
        }

    })


    this.on('deleteChatData', async () => {
        try {
            const { Conversation, Message } = this.entities;
            await DELETE.from(Conversation);
            await DELETE.from(Message);
            return "Success!"
        }
        catch (error) {
            // Handle any errors that occur during the execution
            console.log('Error while deleting the chat content in db:', error);
            throw error;
        }
    })

}