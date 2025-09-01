const cds = require("@sap/cds");
const InvalidSimilaritySearchAlgoNameError = require("./errors/InvalidSimilaritySearchAlgoNameError");

//Currently supported GenAIHub models
const supportedModels = {
  "gptChatModels": new Set(["gpt-4", "gpt-4o", "gpt-4-32k", "gpt-35-turbo-16k", "gpt-35-turbo"]),
  "geminiChatModels": new Set(["gemini-1.0-pro"]),
  "claudeChatModels": new Set(["anthropic--claude-3-sonnet", "anthropic--claude-3-haiku", "anthropic--claude-3-opus", "anthropic--claude-3.5-sonnet"]),
  "gptEmbeddingModels": new Set(["text-embedding-ada-002", "text-embedding-3-small", "text-embedding-3-large"])
};


class CAPLLMPlugin extends cds.Service {
  async init() {
    await super.init();
  }

  /**
   * Retrieve anonymized data for a given entity.
   * @param {string} entityName - Name of the entity.
   * @param {number[]} sequenceIds - Optional Sequence IDs of the entity to retrieve the data. Default is an empty array.
   * @returns {object} - The retrieved anonymized data.
   */
  async getAnonymizedData(entityName, sequenceIds = []) {
    try {
      let [entityService, serviceEntity] = entityName.split(".");
      const entity = cds?.services?.[entityService]?.entities?.[serviceEntity];
      const sequenceColumn = Object.values(entity.elements).find(
        (element) =>
          typeof element["@anonymize"] === "string" &&
          element["@anonymize"].replace(/\s+/g, "").includes("is_sequence")
      );
      if (sequenceColumn === undefined) {
        throw new Error(
          `Sequence column for entity "${entity.name}" not found!`
        );
      }
      const viewName =
        entityName.toUpperCase().replace(/\./g, "_") + "_ANOMYZ_V";
      let query = `select * from "${viewName}"\n`;

      if (sequenceIds.length > 0) {
        query += `where "${sequenceColumn?.name?.toUpperCase()}" in (${sequenceIds
          .map((value) => `'${value}'`)
          .join(", ")});`;
      }

      return await cds.db.run(query);
    } catch (e) {
      console.log(
        `Retrieving anonymized data from SAP HANA Cloud failed. Ensure that the entityName passed exactly matches the format "<service_name>.<entity_name>". Error: `,
        e
      );
      throw e;
    }
  }

  /**
   * get vector embeddings.
   * @param {object} input - The input string to be embedded.
   * @returns {object} - Returns the vector embeddings.
   */
  async getEmbedding(
    input
  ) {
    try {
      console.warn(`This method is for backward compatibilty. This method just supports Azure OpenAI embedding model. Use the 'getEmbeddingWithConfig()' method instead.`);
      const EMBEDDING_MODEL_DESTINATION_NAME = cds.env.requires["GENERATIVE_AI_HUB"]["EMBEDDING_MODEL_DESTINATION_NAME"];
      const EMBEDDING_MODEL_DEPLOYMENT_URL = cds.env.requires["GENERATIVE_AI_HUB"]["EMBEDDING_MODEL_DEPLOYMENT_URL"];
      const EMBEDDING_MODEL_RESOURCE_GROUP = cds.env.requires["GENERATIVE_AI_HUB"]["EMBEDDING_MODEL_RESOURCE_GROUP"];
      const EMBEDDING_MODEL_API_VERSION = cds.env.requires["GENERATIVE_AI_HUB"]["EMBEDDING_MODEL_API_VERSION"];

      const destService = await cds.connect.to(`${EMBEDDING_MODEL_DESTINATION_NAME}`);
      const payload = {
        input: input
      };
      const headers = {
        "Content-Type": "application/json",
        "AI-Resource-Group": `${EMBEDDING_MODEL_RESOURCE_GROUP}`,
      };

      const response = await destService.send({
        query: `POST ${EMBEDDING_MODEL_DEPLOYMENT_URL}/embeddings?api-version=${EMBEDDING_MODEL_API_VERSION}`,
        data: payload,
        headers: headers,
      });
      if (response && response.data) {
        //{data: [ { embedding: [Array], index: 0, object: 'embedding' } ]}
        return response.data[0].embedding;
      }
      else {
        // Handle case where response or response.data is empty
        error_message = 'Empty response or response data.';
        console.log(error_message);
        throw new Error(error_message);
      }
    }
    catch (error) {
      // Handle any errors that occur during the execution
      console.log('Error getting embedding response:', error);
      throw error;
    }
  }

  /**
   * get vector embeddings.
   * @param {object} config - The config obj for the embedding model.
   * @param {object} input - The input string to be embedded.
   * @returns {object} - Returns the result containing the vector embedding from the model.
   */
  async getEmbeddingWithConfig(config, input) {
    try {

      const mandatoryParams = [
        "destinationName",
        "resourceGroup",
        "deploymentUrl",
        "modelName",
      ];

      //validate if mandatory keys are present
      mandatoryParams.forEach((key) => {
        if (!config.hasOwnProperty(key)) {
          throw new Error(`The config is missing the parameter: "${key}".`);
        }
      });

      const supportedEmbeddingModels = [
        {
          modelNames: supportedModels?.gptEmbeddingModels,
          hasApiVersion: true,
          modelTag: "gpt"
        }
      ]

      //validate if model is supported and model requires an api version
      let modelTag = null;
      const modelConfig = supportedEmbeddingModels?.find((model) => model?.modelNames?.has(config?.modelName));
      if (modelConfig) {
        if (modelConfig?.hasApiVersion && !config?.apiVersion) {
          throw new Error(`The config is missing parameter: "apiVersion".`);
        }
        modelTag = modelConfig?.modelTag;
      }
      else {
        throw new Error(`Model ${config?.modelName} is not supported. Please refer the API doumentation for the supported models.`);
      }

      const modelTagUrlMapping = {
        "gpt": `POST ${config?.deploymentUrl}/embeddings?api-version=${config?.apiVersion}`
      }

      const destService = await cds.connect.to(`${config?.destinationName}`);
      const payload = {
        input: input,
      };
      const headers = {
        "Content-Type": "application/json",
        "AI-Resource-Group": `${config?.resourceGroup}`,
      };

      const response = await destService.send({
        query: modelTagUrlMapping[modelTag],
        data: payload,
        headers: headers,
      });

      if (response) {
        return response;
      } else {
        // Handle case where response
        throw new Error("Empty response received.");
      }
    } catch (error) {
      // Handle any errors that occur during the execution
      throw error;
    }
  }


  /**
  * Perform Chat Completion.
  * @param {object} config - The config obj for the embedding model.
  * @param {object} payload - The payload for the chat completion model.
  * @returns {object} - The chat completion results from the model.
  */
  async getChatCompletionWithConfig(config, payload) {
    try {

      //mandatory keys to be present in config
      const mandatoryParams = [
        "destinationName",
        "resourceGroup",
        "deploymentUrl",
        "modelName",
      ];

      //validate if mandatory keys are present
      mandatoryParams.forEach((key) => {
        if (!config.hasOwnProperty(key)) {
          throw new Error(`The config is missing parameter: "${key}".`);
        }
      });

      //supported GenAIHub models with apiVersion requirement
      const supportedChatModels = [
        {
          modelNames: supportedModels?.gptChatModels,
          hasApiVersion: true,
          modelTag: "gpt"
        },
        {
          modelNames: supportedModels?.geminiChatModels,
          hasApiVersion: true,
          modelTag: "gemini"
        },
        {
          modelNames: supportedModels?.claudeChatModels,
          hasApiVersion: false,
          modelTag: "claude"
        }
      ]

      //validate if model is supported and model requires an api version
      let modelTag = null;
      const modelConfig = supportedChatModels?.find((model) => model?.modelNames?.has(config?.modelName));
      if (modelConfig) {
        if (modelConfig?.hasApiVersion && !config?.apiVersion) {
          throw new Error(`The config is missing parameter: "apiVersion".`);
        }
        modelTag = modelConfig?.modelTag;
      }
      else {
        throw new Error(`Model ${config?.modelName} not supported. Please refer the API doumentation for the supported models.`);
      }

      const modelTagUrlMapping = {
        "gpt": `POST ${config?.deploymentUrl}/chat/completions?api-version=${config?.apiVersion}`,
        "gemini": `POST ${config?.deploymentUrl}/models/gemini-1.0-pro-${config?.apiVersion}:generateContent`,
        "claude": `POST ${config?.deploymentUrl}/invoke`
      }

      //destination call to GenAIHub
      const destService = await cds.connect.to(`${config?.destinationName}`);
      const headers = {
        "Content-Type": "application/json",
        "AI-Resource-Group": `${config?.resourceGroup}`,
      };

      const modelurl = modelTagUrlMapping[modelTag];
      const response = await destService.send({
        query: modelTagUrlMapping[modelTag],
        data: payload,
        headers: headers,
      });

      if (response) return response;
      else {
        throw new Error("Empty response received.");
      }

    } catch (error) {
      throw error;
    }
  }


  /**
    * Perform Chat Completion.
    * @param {object} payload - The payload for the chat completion model.
    * @returns {object} - The chat completion results from the model.
    */

  async getChatCompletion(
    payload
  ) {
    try {
      console.warn(`This method is for backward compatibilty. This method just supports Azure OpenAI embedding model. Use the 'getChatCompletionWithConfig()' method instead.`);
      const CHAT_MODEL_DESTINATION_NAME = cds.env.requires["GENERATIVE_AI_HUB"]["CHAT_MODEL_DESTINATION_NAME"];
      const CHAT_MODEL_DEPLOYMENT_URL = cds.env.requires["GENERATIVE_AI_HUB"]["CHAT_MODEL_DEPLOYMENT_URL"];
      const CHAT_MODEL_RESOURCE_GROUP = cds.env.requires["GENERATIVE_AI_HUB"]["CHAT_MODEL_RESOURCE_GROUP"];
      const CHAT_MODEL_API_VERSION = cds.env.requires["GENERATIVE_AI_HUB"]["CHAT_MODEL_API_VERSION"];

      const destService = await cds.connect.to(`${CHAT_MODEL_DESTINATION_NAME}`);
      const headers = {
        "Content-Type": "application/json",
        "AI-Resource-Group": `${CHAT_MODEL_RESOURCE_GROUP}`
      };

      const response = await destService.send({
        query: `POST ${CHAT_MODEL_DEPLOYMENT_URL}/chat/completions?api-version=${CHAT_MODEL_API_VERSION}`,
        data: payload,
        headers: headers,
      });

      if (response && response.choices) {
        return response.choices[0].message;
      } else {
        // Handle case where response or response.data is empty
        error_message = 'Empty response or response data.';
        throw new Error(error_message);
      }
    } catch (error) {
      // Handle any errors that occur during the execution
      console.log('Error getting chat completion response:', error);
      throw error;
    }
  }

  //build payload for different models
  async buildChatPayload(modelName, input, systemPrompt, context, chatParams) {
    try {
      if (supportedModels.gptChatModels.has(modelName)) {

        // Firstly add the system prompt to the payload
        let messagePayload = [
          {
            role: "system",
            content: `${systemPrompt}`,
          },
        ];

        //Push the memory context if passed to the payload
        if (
          typeof context !== "undefined" &&
          context !== null &&
          context.length > 0
        ) {
          console.log("Using the context parameter passed.");
          messagePayload.push(...context);
        }

        //Push the user query into the payload
        messagePayload.push({
          role: "user",
          content: `${input}`
        })

        //construct the chat completion payload and add the current payload
        let payload = {
          messages: messagePayload,
        };

        //if chatParams are passed, add it to the payload
        if (
          chatParams !== null &&
          chatParams !== undefined &&
          Object.keys(chatParams).length > 0
        ) {
          console.log("Using the chatParams parameter passed.");
          payload = Object.assign(payload, chatParams);
        }
        return payload;

      }
      else if (supportedModels.geminiChatModels.has(modelName)) {

        // Firstly add the system prompt to the payload
        let messagePayload = [{
          role: "user",
          parts: [
            { text: `${systemPrompt}` }
          ]
        }];

        //Push the memory context if passed to the payload
        if (
          typeof context !== "undefined" &&
          context !== null &&
          context.length > 0
        ) {
          console.log("Using the context parameter passed.");
          messagePayload.push(...context);
        }

        //Push the user query into the payload
        messagePayload.push({
          role: "user",
          parts: [
            { text: `${input}` }
          ]
        });

        //construct the chat completion payload and add the current payload
        let payload = {
          contents: messagePayload,

        };

        //if chatParams are passed, add it to the payload
        if (
          chatParams !== null &&
          chatParams !== undefined &&
          Object.keys(chatParams).length > 0
        ) {
          console.log("Using the chatParams parameter passed.");
          payload["generationConfig"] = chatParams;
        }
        return payload;
      }
      else if (supportedModels.claudeChatModels.has(modelName)) {
        // Firstly construct the payload
        let messagePayload = [];

        //Push the memory context if passed to the payload
        if (
          typeof context !== "undefined" &&
          context !== null &&
          context.length > 0
        ) {
          console.log("Using the context parameter passed.");
          messagePayload.push(...context);
        }

        //Push the user query into the payload
        messagePayload.push({
          role: "user",
          content: `${input}`
        })

        //construct the chat completion payload and add the current payload
        let payload = {
          messages: messagePayload,
          system: `${systemPrompt}`
        };

        //if chatParams are passed, add it to the payload
        if (
          chatParams !== null &&
          chatParams !== undefined &&
          Object.keys(chatParams).length > 0
        ) {
          console.log("Using the chatParams parameter passed.");
          payload = Object.assign(payload, chatParams);
        }
        return payload;
      }
      else {
        throw new Error(`Chat Model ${modelName} not supported. Please refer the API doumentation for the supported models. `)
      }

    } catch (error) {
      console.log("Error while building the payload.")
      throw error;
    }
  }
  /**
   * Retrieve RAG response from LLM.
   * @param {string} input - User input.
   * @param {string} tableName - The full name of the SAP HANA Cloud table which contains the vector embeddings.
   * @param {string} embeddingColumnName - The full name of the SAP HANA Cloud table column which contains the embeddings.
   * @param {string} contentColumn - The full name of the SAP HANA Cloud table column which contains the page content.
   * @param {string} chatInstruction - The custom prompt user can pass in. Important: Ensure that the prompt contains the message "content which is enclosed in triple quotes".
   * @param {object} embeddingConfig - The configuration for the embedding model.
   * @param {object} chatConfig - The configuration for the chat completion model. 
   * @param {object} context - Optional.The chat history.
   * @param {number} topK - Optional.The number of the entries you want to return. Default value is 3.
   * @param {string} algoName - Optional.The algorithm of similarity search. Currently only COSINE_SIMILARITY and L2DISTANCE are accepted. The default is 'COSINE_SIMILARITY'.
   * @param {object} chatParams - Optional.The additional chat model params.
   * @returns {object} Returns the response from LLM.
   */
  async getRagResponseWithConfig(
    input,
    tableName,
    embeddingColumnName,
    contentColumn,
    chatInstruction,
    embeddingConfig,
    chatConfig,
    context,
    topK = 3,
    algoName = "COSINE_SIMILARITY",
    chatParams
  ) {
    try {
      let queryEmbedding = null;

      //get the embeddings for the user query
      const queryEmbeddingResults = await this.getEmbeddingWithConfig(embeddingConfig, input);

      // parse the embedding result for the respoective model
      // for gptEmbeddingModels
      if (supportedModels?.gptEmbeddingModels?.has(embeddingConfig.modelName)) {
        queryEmbedding = queryEmbeddingResults?.data[0]?.embedding;
      }
      else {
        throw new Error(` Embedding model ${embeddingConfig.modelName} not supported. Please refer the API doumentation for the supported models.`)
      }

      //perform sililarity search on the vector db
      const similaritySearchResults = await this.similaritySearch(
        tableName,
        embeddingColumnName,
        contentColumn,
        queryEmbedding,
        algoName,
        topK
      );
      const similarContent = similaritySearchResults.map(
        (obj) => obj.PAGE_CONTENT
      );

      //system prompt for the RagResponse.
      const systemPrompt = ` ${chatInstruction} \`\`\` ${similarContent} \`\`\` `;

      //construct the payload for the respostive supported models.
      const payload = await this.buildChatPayload(chatConfig?.modelName, input, systemPrompt, context, chatParams);

      //retrieve the chat completion response.
      const chatCompletionResp = await this.getChatCompletionWithConfig(
        chatConfig,
        payload
      );

      //construct the final response payload
      const ragResponse = {
        completion: chatCompletionResp, //complete response from chat completion model
        additionalContents: similaritySearchResults, //complete similarity search results
      };

      return ragResponse;

    } catch (error) {
      // Handle any errors that occur during the execution
      console.log("Error while retriving RAG response:", error);
      throw error;
    }
  }

  /**
      * Retrieve RAG response from LLM.
      * @param {string} input - User input.
      * @param {string} tableName - The full name of the SAP HANA Cloud table which contains the vector embeddings.
      * @param {string} embeddingColumnName - The full name of the SAP HANA Cloud table column which contains the embeddings.
      * @param {string} contentColumn - The full name of the SAP HANA Cloud table column which contains the page content.
      * @param {string} chatInstruction - The custom prompt user can pass in. Important: Ensure that the prompt contains the message "content which is enclosed in triple quotes".
      * @param {object} context - Optional.The chat history.
      * @param {string} algoName - Optional.The algorithm of similarity search. Currently only COSINE_SIMILARITY and L2DISTANCE are accepted. The default is 'COSINE_SIMILARITY'.
      * @param {number} topK - Optional.The number of the entries you want to return. Default value is 3.
      * @param {object} chatParams - Optional.The other chat model params.
  
      * @returns {object} Returns the response from LLM.
      */
  async getRagResponse(
    input,
    tableName,
    embeddingColumnName,
    contentColumn,
    chatInstruction,
    context,
    topK = 3,
    algoName = 'COSINE_SIMILARITY',
    chatParams
  ) {
    try {
      console.warn(`This method is for backward compatibilty. This method just supports Azure OpenAI embedding model. Use the 'getRagResponseWithConfig()' method instead.`);
      const queryEmbedding = await this.getEmbedding(input);
      const similaritySearchResults = await this.similaritySearch(tableName, embeddingColumnName, contentColumn, queryEmbedding, algoName, topK);
      const similarContent = similaritySearchResults.map(obj => obj.PAGE_CONTENT);
      const additionalContents = similaritySearchResults.map(obj => {
        return {
          score: obj.SCORE,
          pageContent: obj.PAGE_CONTENT,
        }
      });
      let messagePayload = [
        {
          "role": "system",
          "content": ` ${chatInstruction} \`\`\` ${similarContent} \`\`\` `
        }
      ]

      const userQuestion = [
        {
          "role": "user",
          "content": `${input}`
        }
      ]

      if (typeof context !== 'undefined' && context !== null && context.length > 0) {
        console.log("Using the context parameter passed.")
        messagePayload.push(...context);
      }

      messagePayload.push(...userQuestion);

      let payload = {
        "messages": messagePayload
      };
      if (chatParams !== null && chatParams !== undefined && Object.keys(chatParams).length > 0) {
        console.log("Using the chatParams parameter passed.")
        payload = Object.assign(payload, chatParams);
      }
      console.log("payload is", payload);
      const chatCompletionResp = await this.getChatCompletion(payload);

      const ragResp = {
        "completion": chatCompletionResp,
        "additionalContents": additionalContents,
      };

      return ragResp;
    }
    catch (error) {
      // Handle any errors that occur during the execution
      console.log('Error during execution:', error);
      throw error;
    }
  }



  /**
   * Perform Similarity Search.
   * @param {string} tableName - The full name of the SAP HANA Cloud table which contains the vector embeddings.
   * @param {string} embeddingColumnName - The full name of the SAP HANA Cloud table column which contains the embeddings.
   * @param {string} contentColumn -  The full name of the SAP HANA Cloud table column which contains the page content.
   * @param {number[]} embedding - The input query embedding for similarity search.
   * @param {string} algoName - The algorithm of similarity search. Currently only COSINE_SIMILARITY and L2DISTANCE are accepted.
   * @param {number} topK - The number of entries you want to return.
   * @returns {object} The highest match entries from DB.
   */
  async similaritySearch(
    tableName,
    embeddingColumnName,
    contentColumn,
    embedding,
    algoName,
    topK
  ) {
    try {
      // Ensure algoName is valid
      const validAlgorithms = ["COSINE_SIMILARITY", "L2DISTANCE"];
      if (!validAlgorithms.includes(algoName)) {
        throw new InvalidSimilaritySearchAlgoNameError(
          `Invalid algorithm name: ${algoName}. Currently only COSINE_SIMILARITY and L2DISTANCE are accepted.`,
          400
        );
      }
      let sortDirection = "DESC";
      if ("L2DISTANCE" === algoName) {
        sortDirection = "ASC";
      }
      const embedding_str = `'[${embedding.toString()}]'`
      const selectStmt = `SELECT TOP ${topK} *,TO_NVARCHAR(${contentColumn}) as PAGE_CONTENT,${algoName}(${embeddingColumnName}, TO_REAL_VECTOR(${embedding_str})) as SCORE FROM ${tableName} ORDER BY SCORE ${sortDirection}`;
      const db = await cds.connect.to('db');
      const result = await db.run(selectStmt);
      if (result) return result;
    } catch (e) {
      if (e instanceof InvalidSimilaritySearchAlgoNameError) {
        throw e;
      } else {
        console.log(
          `Similarity Search failed for entity ${tableName} on attribute ${embeddingColumnName}`,
          e
        );
        throw e;
      }
    }
  }

  /*
 * Retrieves the harmonized chat completion response based on the provided configurations and flags.
 * This method interacts with the OrchestrationClient to generate a chat completion and optionally return specific parts of the response.
 * 
 * @param {object} clientConfig - The configuration for initializing the OrchestrationClient.
 * @param {object} chatCompletionConfig - The configuration for the chat completion request.
 * @param {boolean} [getContent=false] - If true, returns only the content from the response.
 * @param {boolean} [getTokenUsage=false] - If true, returns only the token usage details from the response.
 * @param {boolean} [getFinishReason=false] - If true, returns only the finish reason from the response.
 * @returns {object} The chat completion response ors a specific part of it based on the flags.
 * @throws {Error} Throws an error if the request fails or if the response does not match the expected structure.
 */
async getHarmonizedChatCompletion({
    clientConfig,
    chatCompletionConfig,
    getContent = false,
    getTokenUsage = false,
    getFinishReason = false
  }) {
  const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');

  try {
    // Initialize the OrchestrationClient with the provided client configuration
    const orchestrationClient = new OrchestrationClient(clientConfig);

    // Call the chatCompletion method with the provided chat completion configuration
    const response = await orchestrationClient.chatCompletion(chatCompletionConfig);

    // Extract the desired content from the response based on the flags
    switch (true) {
      case getContent:
        return response.getContent(); // Return content if getContent is true
      case getTokenUsage:
        return response.getTokenUsage(); // Return token usage if getTokenUsage is true
      case getFinishReason:
        return response.getFinishReason(); // Return finish reason if getFinishReason is true
      default:
        return response; // If no flags are true, return the full response
    }
  } catch (e) {
    // Re-throw the error to allow for further handling
    throw e;
  }
}


/**
 * Retrieve content filters based on the provided type and configuration.
 * This function currently supports 'azure' as the valid type.
 * 
 * @param {string} type - The type of content filter to retrieve. Currently, only 'azure' is supported.
 * @param {object} config - The configuration object needed to build the content filter.
 * @returns {object} The content filter based on the specified type, or an error if the type is unsupported.
 * @throws {Error} Throws an error if the type is unsupported or if there are issues with the process.
 */

async  getContentFilters({ type, config }) {
  const { buildAzureContentSafetyFilter } = await import('@sap-ai-sdk/orchestration');

  try {
    // Internal function to handle building Azure content filter
    const getAzureContentFilter = async ({ config }) => {
      return buildAzureContentSafetyFilter(config);
    };

    // Check if the 'type' is 'azure', ignoring case sensitivity
    if (type.toLowerCase() === "azure") {
      // If the type is 'azure', call the internal getAzureContentFilter function
      return await getAzureContentFilter({ config });
    }

    // If the 'type' is not 'azure', throw an error with a helpful message
    throw new Error(`Unsupported type ${type}. The currently supported type is 'azure'.`);
  } catch (e) {
    // Re-throw the error after catching it for further handling
    throw e;
  }
}

}

module.exports = CAPLLMPlugin;
