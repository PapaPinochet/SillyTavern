const fs = require('fs');
const path = require('path');
const { SentencePieceProcessor } = require("@agnai/sentencepiece-js");
const tiktoken = require('@dqbd/tiktoken');
const { Tokenizer } = require('@agnai/web-tokenizers');
const { convertClaudePrompt } = require('./chat-completion');
const { readSecret, SECRET_KEYS } = require('./secrets');

/**
 * @type {{[key: string]: import("@dqbd/tiktoken").Tiktoken}} Tokenizers cache
 */
const tokenizersCache = {};

/**
 * @type {string[]}
 */
const TEXT_COMPLETION_MODELS = [
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-instruct-0914",
    "text-davinci-003",
    "text-davinci-002",
    "text-davinci-001",
    "text-curie-001",
    "text-babbage-001",
    "text-ada-001",
    "code-davinci-002",
    "code-davinci-001",
    "code-cushman-002",
    "code-cushman-001",
    "text-davinci-edit-001",
    "code-davinci-edit-001",
    "text-embedding-ada-002",
    "text-similarity-davinci-001",
    "text-similarity-curie-001",
    "text-similarity-babbage-001",
    "text-similarity-ada-001",
    "text-search-davinci-doc-001",
    "text-search-curie-doc-001",
    "text-search-babbage-doc-001",
    "text-search-ada-doc-001",
    "code-search-babbage-code-001",
    "code-search-ada-code-001",
];

const CHARS_PER_TOKEN = 3.35;

class SentencePieceTokenizer {
    #instance;
    #model;

    constructor(model) {
        this.#model = model;
    }

    /**
     * Gets the Sentencepiece tokenizer instance.
     */
    async get() {
        if (this.#instance) {
            return this.#instance;
        }

        try {
            this.#instance = new SentencePieceProcessor();
            await this.#instance.load(this.#model);
            console.log('Instantiated the tokenizer for', path.parse(this.#model).name);
            return this.#instance;
        } catch (error) {
            console.error("Sentencepiece tokenizer failed to load: " + this.#model, error);
            return null;
        }
    }
}

const spp_llama = new SentencePieceTokenizer('src/sentencepiece/llama.model');
const spp_nerd = new SentencePieceTokenizer('src/sentencepiece/nerdstash.model');
const spp_nerd_v2 = new SentencePieceTokenizer('src/sentencepiece/nerdstash_v2.model');
const spp_mistral = new SentencePieceTokenizer('src/sentencepiece/mistral.model');
let claude_tokenizer;

const sentencepieceTokenizers = [
    'llama',
    'nerdstash',
    'nerdstash_v2',
    'mistral',
];

/**
 * Gets the Sentencepiece tokenizer by the model name.
 * @param {string} model Sentencepiece model name
 * @returns {SentencePieceTokenizer|null} Sentencepiece tokenizer
 */
function getSentencepiceTokenizer(model) {
    if (model.includes('llama')) {
        return spp_llama;
    }

    if (model.includes('nerdstash')) {
        return spp_nerd;
    }

    if (model.includes('mistral')) {
        return spp_mistral;
    }

    if (model.includes('nerdstash_v2')) {
        return spp_nerd_v2;
    }

    return null;
}

/**
 * Counts the token ids for the given text using the Sentencepiece tokenizer.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @param {string} text Text to tokenize
 * @returns { Promise<{ids: number[], count: number}> } Tokenization result
 */
async function countSentencepieceTokens(tokenizer, text) {
    const instance = await tokenizer?.get();

    // Fallback to strlen estimation
    if (!instance) {
        return {
            ids: [],
            count: Math.ceil(text.length / CHARS_PER_TOKEN)
        };
    }

    let cleaned = text; // cleanText(text); <-- cleaning text can result in an incorrect tokenization

    let ids = instance.encodeIds(cleaned);
    return {
        ids,
        count: ids.length
    };
}

/**
 * Counts the tokens in the given array of objects using the Sentencepiece tokenizer.
 * @param {SentencePieceTokenizer} tokenizer
 * @param {object[]} array Array of objects to tokenize
 * @returns {Promise<number>} Number of tokens
 */
async function countSentencepieceArrayTokens(tokenizer, array) {
    const jsonBody = array.flatMap(x => Object.values(x)).join('\n\n');
    const result = await countSentencepieceTokens(tokenizer, jsonBody);
    const num_tokens = result.count;
    return num_tokens;
}

async function getTiktokenChunks(tokenizer, ids) {
    const decoder = new TextDecoder();
    const chunks = [];

    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const chunkTextBytes = await tokenizer.decode(new Uint32Array([id]));
        const chunkText = decoder.decode(chunkTextBytes);
        chunks.push(chunkText);
    }

    return chunks;
}

async function getWebTokenizersChunks(tokenizer, ids) {
    const chunks = [];

    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const chunkText = await tokenizer.decode(new Uint32Array([id]));
        chunks.push(chunkText);
    }

    return chunks;
}

/**
 * Gets the tokenizer model by the model name.
 * @param {string} requestModel Models to use for tokenization
 * @returns {string} Tokenizer model to use
 */
function getTokenizerModel(requestModel) {
    if (requestModel.includes('claude')) {
        return 'claude';
    }

    if (requestModel.includes('llama')) {
        return 'llama';
    }

    if (requestModel.includes('mistral')) {
        return 'mistral';
    }

    if (requestModel.includes('gpt-4-32k')) {
        return 'gpt-4-32k';
    }

    if (requestModel.includes('gpt-4')) {
        return 'gpt-4';
    }

    if (requestModel.includes('gpt-3.5-turbo-0301')) {
        return 'gpt-3.5-turbo-0301';
    }

    if (requestModel.includes('gpt-3.5-turbo')) {
        return 'gpt-3.5-turbo';
    }

    if (TEXT_COMPLETION_MODELS.includes(requestModel)) {
        return requestModel;
    }

    // default
    return 'gpt-3.5-turbo';
}

function getTiktokenTokenizer(model) {
    if (tokenizersCache[model]) {
        return tokenizersCache[model];
    }

    const tokenizer = tiktoken.encoding_for_model(model);
    console.log('Instantiated the tokenizer for', model);
    tokenizersCache[model] = tokenizer;
    return tokenizer;
}

async function loadClaudeTokenizer(modelPath) {
    try {
        const arrayBuffer = fs.readFileSync(modelPath).buffer;
        const instance = await Tokenizer.fromJSON(arrayBuffer);
        return instance;
    } catch (error) {
        console.error("Claude tokenizer failed to load: " + modelPath, error);
        return null;
    }
}

function countClaudeTokens(tokenizer, messages) {
    const convertedPrompt = convertClaudePrompt(messages, false, false);

    // Fallback to strlen estimation
    if (!tokenizer) {
        return Math.ceil(convertedPrompt.length / CHARS_PER_TOKEN);
    }

    const count = tokenizer.encode(convertedPrompt).length;
    return count;
}

/**
 * Creates an API handler for encoding Sentencepiece tokens.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @returns {any} Handler function
 */
function createSentencepieceEncodingHandler(tokenizer) {
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const text = request.body.text || '';
            const instance = await tokenizer?.get();
            const { ids, count } = await countSentencepieceTokens(tokenizer, text);
            const chunks = await instance?.encodePieces(text);
            return response.send({ ids, count, chunks });
        } catch (error) {
            console.log(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    };
}

/**
 * Creates an API handler for decoding Sentencepiece tokens.
 * @param {SentencePieceTokenizer} tokenizer Sentencepiece tokenizer
 * @returns {any} Handler function
 */
function createSentencepieceDecodingHandler(tokenizer) {
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const ids = request.body.ids || [];
            const instance = await tokenizer?.get();
            const text = await instance?.decodeIds(ids);
            return response.send({ text });
        } catch (error) {
            console.log(error);
            return response.send({ text: '' });
        }
    };
}

/**
 * Creates an API handler for encoding Tiktoken tokens.
 * @param {string} modelId Tiktoken model ID
 * @returns {any} Handler function
 */
function createTiktokenEncodingHandler(modelId) {
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const text = request.body.text || '';
            const tokenizer = getTiktokenTokenizer(modelId);
            const tokens = Object.values(tokenizer.encode(text));
            const chunks = await getTiktokenChunks(tokenizer, tokens);
            return response.send({ ids: tokens, count: tokens.length, chunks });
        } catch (error) {
            console.log(error);
            return response.send({ ids: [], count: 0, chunks: [] });
        }
    }
}

/**
 * Creates an API handler for decoding Tiktoken tokens.
 * @param {string} modelId Tiktoken model ID
 * @returns {any} Handler function
 */
function createTiktokenDecodingHandler(modelId) {
    return async function (request, response) {
        try {
            if (!request.body) {
                return response.sendStatus(400);
            }

            const ids = request.body.ids || [];
            const tokenizer = getTiktokenTokenizer(modelId);
            const textBytes = tokenizer.decode(new Uint32Array(ids));
            const text = new TextDecoder().decode(textBytes);
            return response.send({ text });
        } catch (error) {
            console.log(error);
            return response.send({ text: '' });
        }
    }
}

/**
 * Loads the model tokenizers.
 * @returns {Promise<void>} Promise that resolves when the tokenizers are loaded
 */
async function loadTokenizers() {
    claude_tokenizer = await loadClaudeTokenizer('src/claude.json');
}

/**
 * Registers the tokenization endpoints.
 * @param {import('express').Express} app Express app
 * @param {any} jsonParser JSON parser middleware
 */
function registerEndpoints(app, jsonParser) {
    app.post("/api/tokenize/ai21", jsonParser, async function (req, res) {
        if (!req.body) return res.sendStatus(400);
        const options = {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                Authorization: `Bearer ${readSecret(SECRET_KEYS.AI21)}`
            },
            body: JSON.stringify({ text: req.body[0].content })
        };

        try {
            const response = await fetch('https://api.ai21.com/studio/v1/tokenize', options);
            const data = await response.json();
            return res.send({ "token_count": data?.tokens?.length || 0 });
        } catch (err) {
            console.error(err);
            return res.send({ "token_count": 0 });
        }
    });

    app.post("/api/tokenize/llama", jsonParser, createSentencepieceEncodingHandler(spp_llama));
    app.post("/api/tokenize/nerdstash", jsonParser, createSentencepieceEncodingHandler(spp_nerd));
    app.post("/api/tokenize/nerdstash_v2", jsonParser, createSentencepieceEncodingHandler(spp_nerd_v2));
    app.post("/api/tokenize/mistral", jsonParser, createSentencepieceEncodingHandler(spp_mistral));
    app.post("/api/tokenize/gpt2", jsonParser, createTiktokenEncodingHandler('gpt2'));
    app.post("/api/decode/llama", jsonParser, createSentencepieceDecodingHandler(spp_llama));
    app.post("/api/decode/nerdstash", jsonParser, createSentencepieceDecodingHandler(spp_nerd));
    app.post("/api/decode/nerdstash_v2", jsonParser, createSentencepieceDecodingHandler(spp_nerd_v2));
    app.post("/api/decode/mistral", jsonParser, createSentencepieceDecodingHandler(spp_mistral));
    app.post("/api/decode/gpt2", jsonParser, createTiktokenDecodingHandler('gpt2'));

    app.post("/api/tokenize/openai-encode", jsonParser, async function (req, res) {
        try {
            const queryModel = String(req.query.model || '');

            if (queryModel.includes('llama')) {
                const handler = createSentencepieceEncodingHandler(spp_llama);
                return handler(req, res);
            }

            if (queryModel.includes('mistral')) {
                const handler = createSentencepieceEncodingHandler(spp_mistral);
                return handler(req, res);
            }

            if (queryModel.includes('claude')) {
                const text = req.body.text || '';
                const tokens = Object.values(claude_tokenizer.encode(text));
                const chunks = await getWebTokenizersChunks(claude_tokenizer, tokens);
                return res.send({ ids: tokens, count: tokens.length, chunks });
            }

            const model = getTokenizerModel(queryModel);
            const handler = createTiktokenEncodingHandler(model);
            return handler(req, res);
        } catch (error) {
            console.log(error);
            return res.send({ ids: [], count: 0, chunks: [] });
        }
    });

    app.post("/api/tokenize/openai", jsonParser, async function (req, res) {
        try {
            if (!req.body) return res.sendStatus(400);

            let num_tokens = 0;
            const queryModel = String(req.query.model || '');
            const model = getTokenizerModel(queryModel);

            if (model == 'claude') {
                num_tokens = countClaudeTokens(claude_tokenizer, req.body);
                return res.send({ "token_count": num_tokens });
            }

            if (model == 'llama') {
                num_tokens = await countSentencepieceArrayTokens(spp_llama, req.body);
                return res.send({ "token_count": num_tokens });
            }

            if (model == 'mistral') {
                num_tokens = await countSentencepieceArrayTokens(spp_mistral, req.body);
                return res.send({ "token_count": num_tokens });
            }

            const tokensPerName = queryModel.includes('gpt-3.5-turbo-0301') ? -1 : 1;
            const tokensPerMessage = queryModel.includes('gpt-3.5-turbo-0301') ? 4 : 3;
            const tokensPadding = 3;

            const tokenizer = getTiktokenTokenizer(model);

            for (const msg of req.body) {
                try {
                    num_tokens += tokensPerMessage;
                    for (const [key, value] of Object.entries(msg)) {
                        num_tokens += tokenizer.encode(value).length;
                        if (key == "name") {
                            num_tokens += tokensPerName;
                        }
                    }
                } catch {
                    console.warn("Error tokenizing message:", msg);
                }
            }
            num_tokens += tokensPadding;

            // NB: Since 2023-10-14, the GPT-3.5 Turbo 0301 model shoves in 7-9 extra tokens to every message.
            // More details: https://community.openai.com/t/gpt-3-5-turbo-0301-showing-different-behavior-suddenly/431326/14
            if (queryModel.includes('gpt-3.5-turbo-0301')) {
                num_tokens += 9;
            }

            // not needed for cached tokenizers
            //tokenizer.free();

            res.send({ "token_count": num_tokens });
        } catch (error) {
            console.error('An error counting tokens, using fallback estimation method', error);
            const jsonBody = JSON.stringify(req.body);
            const num_tokens = Math.ceil(jsonBody.length / CHARS_PER_TOKEN);
            res.send({ "token_count": num_tokens });
        }
    });
}

module.exports = {
    TEXT_COMPLETION_MODELS,
    getTokenizerModel,
    getTiktokenTokenizer,
    countClaudeTokens,
    loadTokenizers,
    registerEndpoints,
    getSentencepiceTokenizer,
    sentencepieceTokenizers,
}

