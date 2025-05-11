const https = require('https');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
// Change port from 3000 to 3456 to avoid potential conflicts
const PORT = 3456;

// Add file-based logging
const LOG_FILE = path.join(__dirname, 'app.log');

// Simple logging function that writes to console and file
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    
    // Log to console
    console.log(logMessage);
    
    // Log to file
    fs.appendFileSync(LOG_FILE, logMessage + '\n');
}

// Initialize log file
fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] [INFO] Server starting...\n`);

// Cache file path for storing the GitHub data locally
const CACHE_FILE_PATH = path.join(__dirname, 'modelCapabilities.cache.ts');

// Add more detailed error handling
app.use((err, req, res, next) => {
    log(`Express error: ${err.stack}`, 'ERROR');
    res.status(500).send(`
        <h1>Server Error</h1>
        <p>Something went wrong: ${err.message}</p>
        <pre>${err.stack}</pre>
    `);
});

// Function to fetch data from GitHub with all required headers
function fetchGitHubFile(url, callback) {
    log(`Starting fetchGitHubFile for URL: ${url}`);

    // Always fetch from GitHub, bypassing cache
    log('Fetching from GitHub, bypassing cache');
    fetchFromGitHub(url, callback);
}

// Function to fetch data directly from GitHub
function fetchFromGitHub(url, callback) {
    log(`Fetching from ${url}...`);
    
    try {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
                'Accept': 'text/plain',
                'Cache-Control': 'no-cache'
            }
        };
        
        log(`Making HTTP GET request with options: ${JSON.stringify(options)}`);
        
        const req = https.get(url, options, (res) => {
            let data = '';
            
            log(`Response received: Status: ${res.statusCode}, Headers: ${JSON.stringify(res.headers)}`);

            // Check if we're being redirected or getting an error
            if (res.statusCode === 302 || res.statusCode === 301) {
                log(`Following redirect to: ${res.headers.location}`);
                fetchFromGitHub(res.headers.location, callback);
                return;
            }

            if (res.statusCode !== 200) {
                const errorMsg = `HTTP Error: Status Code: ${res.statusCode}, Message: ${res.statusMessage}`;
                log(errorMsg, 'ERROR');
                return callback(new Error(errorMsg));
            }

            res.on('data', (chunk) => {
                data += chunk;
                log(`Received ${chunk.length} bytes of data (total so far: ${data.length})`);
            });

            res.on('end', () => {
                log(`Request complete. Total data length: ${data.length} bytes`);
                
                // Check if we got content or just HTML error page
                if (data.includes('<!DOCTYPE html>') && !data.includes('export interface')) {
                    log('Received HTML instead of TypeScript content - likely an error page', 'ERROR');
                    callback(new Error('Received HTML error page instead of TypeScript content'));
                    return;
                }
                
                // Process the data without caching it
                if (data.length > 0) {
                    log('Successfully fetched data from GitHub');
                    callback(null, data);
                } else {
                    const emptyError = 'Received empty response from GitHub';
                    log(emptyError, 'ERROR');
                    callback(new Error(emptyError));
                }
            });
        });

        req.on('error', (err) => {
            log(`Request error: ${err.stack}`, 'ERROR');
            callback(err);
        });

        // Set a timeout to prevent hanging requests
        req.setTimeout(10000, () => {
            const timeoutError = 'Request timed out after 10 seconds';
            log(timeoutError, 'ERROR');
            req.destroy();
            callback(new Error(timeoutError));
        });
    } catch (err) {
        log(`Exception in fetch function: ${err.stack}`, 'ERROR');
        callback(err);
    }
}

// Parse the TypeScript data to extract model information
function parseModelData(fileContent) {
    log('Parsing model data from TypeScript file');
    
    try {
        // Organize data by provider
        const providers = {};
        
        // Extract provider data
        const providerRegex = /export const defaultProviderSettings = \{([^}]+)\}/s;
        const providerMatch = fileContent.match(providerRegex);
        
        if (providerMatch && providerMatch[1]) {
            const providerData = providerMatch[1].trim();
            const providerLines = providerData.split('\n');
            
            providerLines.forEach(line => {
                const match = line.match(/^\s*(\w+):\s*\{/);
                if (match) {
                    const providerName = match[1];
                    providers[providerName] = {
                        name: providerName,
                        models: [],
                        description: getProviderDescription(providerName)
                    };
                }
            });
        }
        
        // Extract default models of provider
        const defaultModelsRegex = /export const defaultModelsOfProvider = \{([^}]+)\}/s;
        const defaultModelsMatch = fileContent.match(defaultModelsRegex);
        
        if (defaultModelsMatch && defaultModelsMatch[1]) {
            const modelsData = defaultModelsMatch[1].trim();
            
            // Process each provider's models section
            const providerSections = modelsData.split('],');
            
            providerSections.forEach(section => {
                const providerMatch = section.match(/(\w+):\s*\[/);
                if (providerMatch) {
                    const providerName = providerMatch[1];
                    if (providers[providerName]) {
                        // Extract model names
                        const modelMatches = section.match(/'([^']+)'/g);
                        if (modelMatches) {
                            providers[providerName].models = modelMatches.map(m => m.replace(/'/g, ''));
                        }
                    }
                }
            });
        }
        
        // Extract model capabilities from all possible blocks
        const modelInfoBlocks = {};
        
        // Find all model option blocks in the file
        const allModelBlocksRegex = /const\s+(\w+ModelOptions\w*)\s*=\s*\{([^}]+)\}\s*as\s*const/g;
        let modelBlockMatch;
        
        while ((modelBlockMatch = allModelBlocksRegex.exec(fileContent)) !== null) {
            const blockName = modelBlockMatch[1];
            log(`Found model block: ${blockName}`);
            extractModelsFromBlock(fileContent, blockName, modelInfoBlocks);
        }
        
        // Explicitly extract all known blocks to make sure we don't miss any
        extractModelsFromBlock(fileContent, 'openAIModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'anthropicModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'xAIModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'geminiModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'openSourceModelOptions_assumingOAICompat', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'deepseekModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'mistralModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'groqModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'ollamaModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'openRouterModelOptions_assumingOpenAICompat', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'googleVertexModelOptions', modelInfoBlocks);
        extractModelsFromBlock(fileContent, 'microsoftAzureModelOptions', modelInfoBlocks);
        
        // Create a list of models that should be included in each provider, even if not explicitly listed
        const extraModels = {};
        
        // Add model capabilities to providers
        for (const providerName in providers) {
            if (!providers[providerName].models) {
                providers[providerName].models = [];
            }
            
            // Check if this provider has any explicitly specified models
            const hasExplicitModels = providers[providerName].models.length > 0;
            
            // If no explicit models, try to find models for this provider from model blocks
            if (!hasExplicitModels) {
                for (const modelName in modelInfoBlocks) {
                    if (modelName.toLowerCase().includes(providerName.toLowerCase()) || 
                        (extraModels[providerName] && extraModels[providerName].includes(modelName))) {
                        providers[providerName].models.push(modelName);
                    }
                }
            }
            
            // Map models to their capabilities
            providers[providerName].models = providers[providerName].models.map(modelName => {
                // Try to find model details
                const modelDetails = findModelDetails(modelName, modelInfoBlocks);
                return {
                    name: modelName,
                    capabilities: modelDetails || {}
                };
            });
            
            // Remove duplicates (same model name)
            const uniqueModels = {};
            providers[providerName].models = providers[providerName].models.filter(model => {
                if (!uniqueModels[model.name]) {
                    uniqueModels[model.name] = true;
                    return true;
                }
                return false;
            });
            
            // Sort models by name
            providers[providerName].models.sort((a, b) => a.name.localeCompare(b.name));
        }
        
        // Add models from model blocks that don't have a provider
        const unassignedModels = {};
        for (const modelName in modelInfoBlocks) {
            let assigned = false;
            
            for (const providerName in providers) {
                if (providers[providerName].models.some(m => m.name === modelName)) {
                    assigned = true;
                    break;
                }
            }
            
            if (!assigned) {
                const providerHint = getProviderFromModelName(modelName);
                if (providerHint && providers[providerHint]) {
                    if (!providers[providerHint].unlistedModels) {
                        providers[providerHint].unlistedModels = [];
                    }
                    providers[providerHint].unlistedModels.push({
                        name: modelName,
                        capabilities: modelInfoBlocks[modelName] || {}
                    });
                } else {
                    if (!unassignedModels['other']) {
                        unassignedModels['other'] = [];
                    }
                    unassignedModels['other'].push({
                        name: modelName,
                        capabilities: modelInfoBlocks[modelName] || {}
                    });
                }
            }
        }
        
        // Add the "Other Models" provider if we have unassigned models
        if (unassignedModels['other'] && unassignedModels['other'].length > 0) {
            providers['other'] = {
                name: 'other',
                models: unassignedModels['other'],
                description: 'Models that are not explicitly associated with a specific provider.'
            };
        }
        
        // Add unlisted models to their respective providers
        for (const providerName in providers) {
            if (providers[providerName].unlistedModels) {
                providers[providerName].models = [
                    ...providers[providerName].models,
                    ...providers[providerName].unlistedModels
                ];
                delete providers[providerName].unlistedModels;
            }
        }

        // Add empty providers with no models
        for (const providerName in providers) {
            if (!providers[providerName].models || providers[providerName].models.length === 0) {
                providers[providerName].models = [{
                    name: `No models listed for ${providerName}`,
                    capabilities: {}
                }];
            }
        }
        
        return { providers };
    } catch (err) {
        log(`Error parsing model data: ${err.message}`, 'ERROR');
        return { providers: {} };
    }
}

// Helper function to get provider descriptions
function getProviderDescription(providerName) {
    const descriptions = {
        openAI: "OpenAI's cutting-edge models known for state-of-the-art performance across a wide range of tasks.",
        anthropic: "Anthropic's Claude models emphasize safety, helpfulness, and alignment with human values.",
        xAI: "X.AI's Grok models designed to be informative, conversational, and knowledgeable.",
        gemini: "Google's Gemini multimodal models combining text, code, images, and more.",
        deepseek: "DeepSeek's models focusing on deep reasoning and specialized for coding tasks.",
        ollama: "Open-source platform for running local models with easy setup and management.",
        vLLM: "High-throughput, memory-efficient inference engine for large language models.",
        openRouter: "Platform providing unified access to models from multiple providers.",
        groq: "Fast inference platform with optimized infrastructure for LLM performance.",
        mistral: "Models designed for efficiency and performance in a range of enterprise applications.",
        openAICompatible: "Models compatible with OpenAI's API format from various providers.",
        lmStudio: "Desktop application for running LLMs locally with an intuitive interface.",
        liteLLM: "Tool for standardizing API calls across different LLM providers.",
        googleVertex: "Google's Vertex AI platform for machine learning and AI model deployment.",
        microsoftAzure: "Microsoft's cloud-based AI services with integration into Azure.",
        meta: "Meta's Llama family of open source large language models.",
        qwen: "Alibaba Cloud's Qwen models excelling in reasoning and multilingual capabilities.",
        other: "Miscellaneous AI models from various providers."
    };
    
    return descriptions[providerName] || `AI model provider: ${providerName}`;
}

// Helper function to guess provider from model name
function getProviderFromModelName(modelName) {
    const modelLower = modelName.toLowerCase();
    
    if (modelLower.includes('gpt') || modelLower.startsWith('o1') || modelLower.startsWith('o3') || modelLower.startsWith('o4')) {
        return 'openAI';
    }
    if (modelLower.includes('claude')) {
        return 'anthropic';
    }
    if (modelLower.includes('grok')) {
        return 'xAI';
    }
    if (modelLower.includes('gemini')) {
        return 'gemini';
    }
    if (modelLower.includes('llama')) {
        return 'meta'; // Create new provider for Meta models
    }
    if (modelLower.includes('mistral') || modelLower.includes('codestral')) {
        return 'mistral';
    }
    if (modelLower.includes('deepseek')) {
        return 'deepseek';
    }
    if (modelLower.includes('qwen')) {
        return 'qwen'; // Create new provider for Qwen models
    }
    
    return null;
}

// Helper function to extract models from a block
function extractModelsFromBlock(fileContent, blockName, modelInfoBlocks) {
    // Try both formats: "const blockName = {" and "export const blockName = {"
    const blockRegexes = [
        new RegExp(`const ${blockName} = \\{([\\s\\S]+?)\\} as const`),
        new RegExp(`export const ${blockName} = \\{([\\s\\S]+?)\\} as const`)
    ];
    
    let blockMatch = null;
    for (const regex of blockRegexes) {
        const match = fileContent.match(regex);
        if (match) {
            blockMatch = match;
            break;
        }
    }
    
    if (blockMatch && blockMatch[1]) {
        const blockContent = blockMatch[1].trim();
        
        // Split the block content into individual model sections
        // More robust splitting to handle complex nested structures
        const modelSections = [];
        let currentSection = '';
        let depth = 0;
        let inModelSection = false;
        let currentModelName = '';
        
        // Split by model name entries (matching 'model-name': { ... })
        const modelNameRegex = /'([^']+)':\s*\{/g;
        let lastIndex = 0;
        let match;
        
        while ((match = modelNameRegex.exec(blockContent)) !== null) {
            if (lastIndex > 0) {
                // Extract the section from lastIndex to current match index
                modelSections.push({
                    name: currentModelName,
                    content: blockContent.substring(lastIndex, match.index)
                });
            }
            
            currentModelName = match[1];
            lastIndex = match.index;
        }
        
        // Add the last section
        if (lastIndex > 0) {
            modelSections.push({
                name: currentModelName,
                content: blockContent.substring(lastIndex)
            });
        }
        
        // If the regex approach didn't work, fall back to the original method
        if (modelSections.length === 0) {
            const simpleModelSections = blockContent.split(/(?='\w+[-\w\d.]*':)/);
            
            simpleModelSections.forEach(section => {
                const modelNameMatch = section.match(/'([^']+)'\s*:/);
                if (modelNameMatch) {
                    const modelName = modelNameMatch[1];
                    modelSections.push({
                        name: modelName,
                        content: section
                    });
                }
            });
        }
        
        // Parse each model section
        modelSections.forEach(section => {
            if (section.name) {
                modelInfoBlocks[section.name] = parseModelDetails(section.content);
            }
        });
    } else {
        log(`Could not find model block: ${blockName}`, 'WARN');
    }
}

// Helper function to parse model details
function parseModelDetails(modelSection) {
    const details = {};
    
    // Extract context window
    const contextWindowMatch = modelSection.match(/contextWindow:\s*([^,\n]+)/);
    if (contextWindowMatch) {
        details.contextWindow = parseInt(contextWindowMatch[1].replace(/[^0-9]/g, ''), 10);
    }
    
    // Extract reserved output token space
    const reservedOutputMatch = modelSection.match(/reservedOutputTokenSpace:\s*([^,\n]+)/);
    if (reservedOutputMatch) {
        const value = reservedOutputMatch[1].trim();
        details.reservedOutputTokenSpace = value === 'null' ? 'Not specified' : 
            parseInt(value.replace(/[^0-9]/g, ''), 10);
    }
    
    // Extract system message support
    const systemMessageMatch = modelSection.match(/supportsSystemMessage:\s*([^,\n]+)/);
    if (systemMessageMatch) {
        const value = systemMessageMatch[1].trim();
        details.supportsSystemMessage = value === 'false' ? false : value.replace(/'/g, '');
    }
    
    // Extract FIM support
    const fimMatch = modelSection.match(/supportsFIM:\s*([^,\n]+)/);
    if (fimMatch) {
        details.supportsFIM = fimMatch[1].trim() === 'true';
    }
    
    // Extract special tool format
    const toolFormatMatch = modelSection.match(/specialToolFormat:\s*['"]([^'"]+)['"]/);
    if (toolFormatMatch) {
        details.specialToolFormat = toolFormatMatch[1];
    }
    
    // Extract reasoning capabilities (more detailed parsing)
    const reasoningMatch = modelSection.match(/reasoningCapabilities:\s*(\{[^}]+\}|false)/);
    if (reasoningMatch) {
        const value = reasoningMatch[1].trim();
        if (value === 'false') {
            details.hasReasoning = false;
        } else {
            details.hasReasoning = true;
            
            // Extract additional reasoning details
            const canTurnOffMatch = value.match(/canTurnOffReasoning:\s*([^,\n]+)/);
            if (canTurnOffMatch) {
                details.canTurnOffReasoning = canTurnOffMatch[1].trim() === 'true';
            }
            
            const canIOReasoning = value.match(/canIOReasoning:\s*([^,\n]+)/);
            if (canIOReasoning) {
                details.canIOReasoning = canIOReasoning[1].trim() === 'true';
            }
            
            const reasoningSliderMatch = value.match(/reasoningSlider:\s*(\{[^}]+\})/);
            if (reasoningSliderMatch) {
                const sliderValue = reasoningSliderMatch[1];
                
                const sliderTypeMatch = sliderValue.match(/type:\s*['"]([^'"]+)['"]/);
                if (sliderTypeMatch) {
                    details.reasoningSliderType = sliderTypeMatch[1];
                }
                
                if (details.reasoningSliderType === 'budget_slider') {
                    const minMatch = sliderValue.match(/min:\s*(\d+)/);
                    const maxMatch = sliderValue.match(/max:\s*(\d+)/);
                    const defaultMatch = sliderValue.match(/default:\s*(\d+)/);
                    
                    if (minMatch) details.reasoningBudgetMin = parseInt(minMatch[1], 10);
                    if (maxMatch) details.reasoningBudgetMax = parseInt(maxMatch[1], 10);
                    if (defaultMatch) details.reasoningBudgetDefault = parseInt(defaultMatch[1], 10);
                } else if (details.reasoningSliderType === 'effort_slider') {
                    const valuesMatch = sliderValue.match(/values:\s*\[([^\]]+)\]/);
                    const defaultMatch = sliderValue.match(/default:\s*['"]([^'"]+)['"]/);
                    
                    if (valuesMatch) {
                        details.reasoningEffortValues = valuesMatch[1].split(',').map(v => 
                            v.trim().replace(/['"]/g, '')
                        );
                    }
                    if (defaultMatch) {
                        details.reasoningEffortDefault = defaultMatch[1];
                    }
                }
            }
            
            // Extract thinking tags
            const thinkTagsMatch = value.match(/openSourceThinkTags:\s*\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]/);
            if (thinkTagsMatch) {
                details.thinkTags = [thinkTagsMatch[1], thinkTagsMatch[2]];
            }
        }
    }
    
    // Extract cost information
    const costMatch = modelSection.match(/cost:\s*{\s*([^}]+)\s*}/);
    if (costMatch) {
        const costInfo = {};
        const costContent = costMatch[1];
        
        const inputMatch = costContent.match(/input:\s*([^,\n]+)/);
        if (inputMatch) {
            costInfo.input = parseFloat(inputMatch[1]);
        }
        
        const outputMatch = costContent.match(/output:\s*([^,\n]+)/);
        if (outputMatch) {
            costInfo.output = parseFloat(outputMatch[1]);
        }
        
        const cacheReadMatch = costContent.match(/cache_read:\s*([^,\n]+)/);
        if (cacheReadMatch) {
            costInfo.cacheRead = parseFloat(cacheReadMatch[1]);
        }
        
        const cacheWriteMatch = costContent.match(/cache_write:\s*([^,\n]+)/);
        if (cacheWriteMatch) {
            costInfo.cacheWrite = parseFloat(cacheWriteMatch[1]);
        }
        
        details.cost = costInfo;
    }
    
    // Extract downloadable info
    const downloadableMatch = modelSection.match(/downloadable:\s*([^,\n]+)/);
    if (downloadableMatch) {
        const value = downloadableMatch[1].trim();
        details.downloadable = value !== 'false';
        
        if (details.downloadable) {
            const sizeMatch = modelSection.match(/sizeGb:\s*([^,\n}]+)/);
            if (sizeMatch) {
                const sizeValue = sizeMatch[1].trim();
                details.downloadSize = sizeValue === "'not-known'" ? 'Unknown' : `${parseFloat(sizeValue)} GB`;
            }
        }
    }
    
    return details;
}

// Helper function to find model details from all extracted models
function findModelDetails(modelName, modelInfoBlocks) {
    // Direct match
    if (modelInfoBlocks[modelName]) {
        return modelInfoBlocks[modelName];
    }
    
    // Try to find a close match by removing version numbers and other variations
    const normalizedModelName = modelName.toLowerCase()
        .replace(/[-_\s.]/g, '') // Remove dashes, underscores, spaces, and dots
        .replace(/\d+\.\d+/g, '') // Remove version numbers like 3.5
        .replace(/\d+b/g, '') // Remove sizes like 7b, 13b
        .replace(/:.*$/, ''); // Remove anything after colon
    
    for (const blockModelName in modelInfoBlocks) {
        const normalizedBlockName = blockModelName.toLowerCase()
            .replace(/[-_\s.]/g, '')
            .replace(/\d+\.\d+/g, '')
            .replace(/\d+b/g, '')
            .replace(/:.*$/, '');
            
        // Check for substring matches in both directions
        if (normalizedModelName.includes(normalizedBlockName) || 
            normalizedBlockName.includes(normalizedModelName)) {
            return modelInfoBlocks[blockModelName];
        }
    }
    
    // Check for specific model families
    const modelFamilies = {
        'gpt4': ['gpt-4', 'gpt-4o', 'gpt-4.1', 'o4'],
        'gpt3': ['gpt-3.5', 'gpt-3'],
        'claude': ['claude-3', 'claude-3.5', 'claude-3.7', 'claude-3-opus', 'claude-3-sonnet'],
        'llama': ['llama3', 'llama-3', 'llama-3.1', 'llama-3.2', 'llama-3.3'],
        'gemini': ['gemini-1.5', 'gemini-2.0', 'gemini-2.5'],
        'mistral': ['mistral', 'ministral', 'codestral'],
        'qwen': ['qwen', 'qwen-2.5', 'qwen-3', 'qwq']
    };
    
    // Check if model belongs to a known family
    for (const family in modelFamilies) {
        if (modelFamilies[family].some(pattern => modelName.toLowerCase().includes(pattern.toLowerCase()))) {
            // Look for any model in the same family
            for (const blockModelName in modelInfoBlocks) {
                if (modelFamilies[family].some(pattern => blockModelName.toLowerCase().includes(pattern.toLowerCase()))) {
                    return modelInfoBlocks[blockModelName];
                }
            }
        }
    }
    
    return null;
}

// Try different GitHub URLs to find one that works
const GITHUB_URLS = [
    'https://raw.githubusercontent.com/voideditor/void/main/src/vs/workbench/contrib/void/common/modelCapabilities.ts',
    'https://raw.githubusercontent.com/voideditor/void/master/src/vs/workbench/contrib/void/common/modelCapabilities.ts',
    'https://raw.githubusercontent.com/voideditor/void/refs/heads/main/src/vs/workbench/contrib/void/common/modelCapabilities.ts'
];

// Hardcoded data as a fallback if everything else fails
const FALLBACK_DATA = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This is a fallback version of the model capabilities data
// The actual data will be fetched from GitHub when the app runs

export interface IModelCapability {
    readonly id: string;
    readonly description: string;
}

export interface IModelCapabilities {
    readonly textCompletion: boolean;
    readonly chatCompletion: boolean;
    readonly messageCompletion: boolean;
    readonly toolCalling: boolean;
    readonly multiModal: boolean;
}`;

// Route to fetch and display the data
app.get('/', (req, res) => {
    try {
        log('Received request for / route');
        
        // Try the first GitHub URL
        tryFetchFromGitHub(0, res);
    } catch (routeError) {
        log(`Uncaught error in route: ${routeError.stack}`, 'ERROR');
        res.status(500).send(`
            <h1>Unexpected Error</h1>
            <p>${routeError.message}</p>
            <pre>${routeError.stack}</pre>
            <p>Check the server logs at ${LOG_FILE} for more details.</p>
        `);
    }
});

// Function to try multiple GitHub URLs until one works
function tryFetchFromGitHub(urlIndex, res) {
    if (urlIndex >= GITHUB_URLS.length) {
        log('All GitHub URLs failed, using fallback data', 'WARN');
        renderPage(null, FALLBACK_DATA, res, new Error('All GitHub URLs failed'));
        return;
    }
    
    const url = GITHUB_URLS[urlIndex];
    log(`Trying GitHub URL #${urlIndex + 1}: ${url}`);
    
    fetchGitHubFile(url, (err, data) => {
        if (err) {
            log(`Error with URL ${url}: ${err.message}`, 'WARN');
            // Try the next URL
            tryFetchFromGitHub(urlIndex + 1, res);
        } else {
            log(`Successfully fetched data from ${url}`);
            renderPage(null, data, res);
        }
    });
}

// Function to render the HTML page with the data
function renderPage(err, fileData, res, fallbackErr = null) {
    try {
        // Use the error passed in or the fallback error
        const error = err || fallbackErr;
        
        log(`Rendering page with ${fileData.length} bytes of data${error ? ' (with error)' : ''}`);
        
        // Parse the TypeScript data to extract useful model information
        const modelData = parseModelData(fileData);
        
        // Format the data into a nice HTML table
        const formattedContent = generateFormattedHTML(modelData);
        
        // Generate the HTML page
        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>AI Model Capabilities Viewer</title>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
                <style>
                    :root {
                        --primary-color: #2563eb;
                        --secondary-color: #4f46e5;
                        --accent-color: #6366f1;
                        --text-color: #1e293b;
                        --light-text: #64748b;
                        --bg-color: #f8fafc;
                        --card-bg: #ffffff;
                        --border-color: #e2e8f0;
                        --success-color: #10b981;
                        --error-color: #ef4444;
                        --warning-color: #f59e0b;
                    }
                    
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                        line-height: 1.6; 
                        margin: 0;
                        padding: 0;
                        color: var(--text-color);
                        background-color: var(--bg-color);
                    }
                    
                    .container {
                        max-width: 1200px;
                        margin: 0 auto;
                        padding: 2rem 1rem;
                    }
                    
                    header {
                        background-color: var(--primary-color);
                        color: white;
                        padding: 1.5rem 0;
                        margin-bottom: 2rem;
                        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                    }
                    
                    header .container {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding-top: 0;
                        padding-bottom: 0;
                    }
                    
                    h1, h2, h3, h4 {
                        margin-top: 0;
                        font-weight: 600;
                    }
                    
                    h1 {
                        font-size: 2rem;
                        margin-bottom: 0.5rem;
                    }
                    
                    .header-subtitle {
                        font-size: 1rem;
                        font-weight: 400;
                        opacity: 0.9;
                    }
                    
                    .provider-card {
                        background-color: var(--card-bg);
                        border-radius: 0.5rem;
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                        margin-bottom: 1.5rem;
                        overflow: hidden;
                        border: 1px solid var(--border-color);
                    }
                    
                    .provider-header {
                        padding: 1rem 1.5rem;
                        background-color: #f1f5f9;
                        border-bottom: 1px solid var(--border-color);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        cursor: pointer;
                    }
                    
                    .provider-header h2 {
                        margin: 0;
                        font-size: 1.25rem;
                    }
                    
                    .provider-content {
                        padding: 1.5rem;
                    }
                    
                    .provider-description {
                        margin-bottom: 1.5rem;
                        color: var(--light-text);
                    }
                    
                    .model-list {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
                        gap: 1rem;
                    }
                    
                    .model-card {
                        background-color: #f8fafc;
                        border-radius: 0.375rem;
                        border: 1px solid var(--border-color);
                        padding: 1rem;
                        transition: all 0.2s ease;
                    }
                    
                    .model-card:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                    }
                    
                    .model-header {
                        margin-bottom: 0.75rem;
                        padding-bottom: 0.5rem;
                        border-bottom: 1px solid var(--border-color);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    
                    .model-name {
                        font-weight: 600;
                        font-size: 1.125rem;
                        margin: 0;
                    }
                    
                    .model-badge {
                        font-size: 0.75rem;
                        padding: 0.25rem 0.5rem;
                        border-radius: 9999px;
                        background-color: #e0e7ff;
                        color: #4f46e5;
                    }
                    
                    .model-details {
                        display: grid;
                        grid-template-columns: repeat(2, 1fr);
                        gap: 0.5rem 1rem;
                    }
                    
                    .model-detail {
                        display: flex;
                        flex-direction: column;
                    }
                    
                    .detail-label {
                        font-size: 0.75rem;
                        color: var(--light-text);
                        margin-bottom: 0.25rem;
                    }
                    
                    .detail-value {
                        font-weight: 500;
                    }
                    
                    .indicator {
                        display: inline-flex;
                        align-items: center;
                        gap: 0.25rem;
                    }
                    
                    .indicator-yes {
                        color: var(--success-color);
                    }
                    
                    .indicator-no {
                        color: var(--error-color);
                    }
                    
                    .toggle-icon {
                        font-size: 1.25rem;
                        transition: transform 0.2s ease;
                    }
                    
                    .collapsed .toggle-icon {
                        transform: rotate(-90deg);
                    }
                    
                    .provider-content {
                        display: block;
                    }
                    
                    .collapsed .provider-content {
                        display: none;
                    }
                    
                    .search-bar {
                        display: flex;
                        margin-bottom: 1.5rem;
                    }
                    
                    .search-input {
                        flex: 1;
                        padding: 0.75rem 1rem;
                        font-size: 1rem;
                        border: 1px solid var(--border-color);
                        border-radius: 0.375rem;
                        outline: none;
                    }
                    
                    .search-input:focus {
                        border-color: var(--primary-color);
                        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
                    }
                    
                    .feature-pills {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 0.5rem;
                        margin-top: 0.5rem;
                    }
                    
                    .feature-pill {
                        font-size: 0.75rem;
                        padding: 0.25rem 0.5rem;
                        border-radius: 9999px;
                        background-color: #f1f5f9;
                        color: var(--light-text);
                    }
                    
                    .tooltip {
                        position: relative;
                        cursor: help;
                    }
                    
                    .tooltip:hover::after {
                        content: attr(data-tooltip);
                        position: absolute;
                        bottom: 100%;
                        left: 50%;
                        transform: translateX(-50%);
                        padding: 0.5rem;
                        background-color: rgba(0, 0, 0, 0.8);
                        color: white;
                        border-radius: 0.25rem;
                        font-size: 0.75rem;
                        white-space: nowrap;
                        z-index: 10;
                    }
                    
                    .costs {
                        display: flex;
                        gap: 0.5rem;
                        margin-top: 0.5rem;
                    }
                    
                    .cost-item {
                        font-size: 0.75rem;
                        display: flex;
                        align-items: center;
                        gap: 0.25rem;
                    }
                    
                    .cost-free {
                        color: var(--success-color);
                    }
                    
                    .error-note {
                        background-color: #fff3cd;
                        color: #856404;
                        padding: 1rem;
                        border-radius: 0.375rem;
                        margin-bottom: 1.5rem;
                        display: ${error ? 'block' : 'none'};
                    }
                    
                    .file-path {
                        margin-bottom: 1.5rem;
                        color: var(--light-text);
                        font-size: 0.875rem;
                    }
                    
                    .footer {
                        margin-top: 2rem;
                        text-align: center;
                        padding: 1rem;
                        color: var(--light-text);
                        font-size: 0.875rem;
                        border-top: 1px solid var(--border-color);
                    }
                    
                    .view-raw-btn {
                        display: inline-block;
                        padding: 0.5rem 1rem;
                        background-color: var(--primary-color);
                        color: white;
                        border-radius: 0.375rem;
                        text-decoration: none;
                        font-weight: 500;
                        margin-top: 1rem;
                    }
                    
                    .raw-data {
                        display: none;
                        margin-top: 2rem;
                    }
                    
                    pre {
                        background-color: #1e293b;
                        color: #f1f5f9;
                        padding: 1rem;
                        border-radius: 0.375rem;
                        overflow-x: auto;
                        font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
                        font-size: 0.875rem;
                    }
                    
                    @media (max-width: 768px) {
                        .model-list {
                            grid-template-columns: 1fr;
                        }
                        
                        .model-details {
                            grid-template-columns: 1fr;
                        }
                    }
                </style>
            </head>
            <body>
                <header>
                    <div class="container">
                        <div>
                            <h1>AI Model Capabilities</h1>
                            <div class="header-subtitle">A comprehensive overview of capabilities across AI models</div>
                        </div>
                    </div>
                </header>
                
                <div class="container">
                    <div class="error-note">
                        ${error ? `Note: ${error.message}` : ''}
                    </div>
                    
                    <div class="file-path">Data source: voideditor/void/src/vs/workbench/contrib/void/common/modelCapabilities.ts</div>
                    
                    <div class="search-bar">
                        <input type="text" id="searchInput" class="search-input" placeholder="Search for models or providers..." />
                    </div>
                    
                    <div id="modelContainer">
                        ${formattedContent}
                    </div>
                    
                    <button id="toggleRawBtn" class="view-raw-btn">View Raw Data</button>
                    
                    <div id="rawData" class="raw-data">
                        <pre>${fileData}</pre>
                    </div>
                </div>
                
                <footer class="footer">
                    <p>Data last updated: May 10, 2025</p>
                </footer>
                
                <script>
                    // Toggle provider section
                    document.querySelectorAll('.provider-header').forEach(header => {
                        header.addEventListener('click', () => {
                            const card = header.closest('.provider-card');
                            card.classList.toggle('collapsed');
                        });
                    });
                    
                    // Toggle raw data view
                    const toggleRawBtn = document.getElementById('toggleRawBtn');
                    const rawData = document.getElementById('rawData');
                    
                    toggleRawBtn.addEventListener('click', () => {
                        if (rawData.style.display === 'block') {
                            rawData.style.display = 'none';
                            toggleRawBtn.textContent = 'View Raw Data';
                        } else {
                            rawData.style.display = 'block';
                            toggleRawBtn.textContent = 'Hide Raw Data';
                        }
                    });
                    
                    // Search functionality
                    const searchInput = document.getElementById('searchInput');
                    
                    searchInput.addEventListener('input', () => {
                        const query = searchInput.value.toLowerCase();
                        
                        document.querySelectorAll('.provider-card').forEach(providerCard => {
                            const providerName = providerCard.querySelector('.provider-header h2').textContent.toLowerCase();
                            let providerVisible = providerName.includes(query);
                            let hasVisibleModels = false;
                            
                            providerCard.querySelectorAll('.model-card').forEach(modelCard => {
                                const modelName = modelCard.querySelector('.model-name').textContent.toLowerCase();
                                const modelDetails = modelCard.textContent.toLowerCase();
                                const modelVisible = modelName.includes(query) || modelDetails.includes(query);
                                
                                modelCard.style.display = modelVisible || query === '' ? 'block' : 'none';
                                
                                if (modelVisible) {
                                    hasVisibleModels = true;
                                }
                            });
                            
                            providerCard.style.display = (providerVisible || hasVisibleModels || query === '') ? 'block' : 'none';
                            
                            // Expand provider card if searching
                            if (query !== '') {
                                providerCard.classList.remove('collapsed');
                            }
                        });
                    });
                </script>
            </body>
            </html>
        `;

        res.send(html);
        log('Successfully served HTML page');
    } catch (renderError) {
        log(`Error rendering page: ${renderError.stack}`, 'ERROR');
        res.status(500).send(`
            <h1>Error Rendering Data</h1>
            <p>There was an error processing the data: ${renderError.message}</p>
            <pre>${renderError.stack}</pre>
            <p>Check the server logs at ${LOG_FILE} for more details.</p>
            <hr>
            <h2>Raw Data</h2>
            <pre>${fileData}</pre>
        `);
    }
}

// Generate formatted HTML from parsed model data
function generateFormattedHTML(modelData) {
    let html = '';
    
    const { providers } = modelData;
    
    // Sort providers alphabetically
    const sortedProviders = Object.values(providers).sort((a, b) => a.name.localeCompare(b.name));
    
    for (const provider of sortedProviders) {
        html += `
            <div class="provider-card">
                <div class="provider-header">
                    <h2>${formatProviderName(provider.name)}</h2>
                    <i class="fas fa-chevron-down toggle-icon"></i>
                </div>
                <div class="provider-content">
                    <div class="provider-description">${provider.description}</div>
                    <div class="model-list">
        `;
        
        // Sort models alphabetically
        const sortedModels = provider.models.sort((a, b) => a.name.localeCompare(b.name));
        
        for (const model of sortedModels) {
            const capabilities = model.capabilities || {};
            
            html += `
                <div class="model-card">
                    <div class="model-header">
                        <h3 class="model-name">${model.name}</h3>
                        ${capabilities.downloadable ? 
                            `<span class="model-badge"><i class="fas fa-download"></i> ${capabilities.downloadSize || 'Downloadable'}</span>` : 
                            ''}
                    </div>
                    <div class="model-details">
            `;
            
            // Only show details if we have capabilities information
            if (Object.keys(capabilities).length > 0) {
                html += `
                    <div class="model-detail">
                        <span class="detail-label">Context Window</span>
                        <span class="detail-value">${formatNumber(capabilities.contextWindow || 'Not specified')}</span>
                    </div>
                    <div class="model-detail">
                        <span class="detail-label">Reserved Output Tokens</span>
                        <span class="detail-value">${formatNumber(capabilities.reservedOutputTokenSpace || 'Not specified')}</span>
                    </div>
                    <div class="model-detail">
                        <span class="detail-label">Fill-in-Middle Support</span>
                        <span class="detail-value">
                            ${capabilities.supportsFIM ? 
                                '<span class="indicator indicator-yes"><i class="fas fa-check"></i> Yes</span>' : 
                                '<span class="indicator indicator-no"><i class="fas fa-times"></i> No</span>'}
                        </span>
                    </div>
                `;
                
                // Enhanced reasoning capabilities display
                if (capabilities.hasReasoning !== undefined) {
                    html += `
                        <div class="model-detail">
                            <span class="detail-label">Reasoning Capabilities</span>
                            <span class="detail-value">
                                ${capabilities.hasReasoning ? 
                                    '<span class="indicator indicator-yes"><i class="fas fa-check"></i> Yes</span>' : 
                                    '<span class="indicator indicator-no"><i class="fas fa-times"></i> No</span>'}
                            </span>
                        </div>
                    `;
                    
                    // Show additional reasoning details if available
                    if (capabilities.hasReasoning) {
                        if (capabilities.canTurnOffReasoning !== undefined) {
                            html += `
                                <div class="model-detail">
                                    <span class="detail-label">Can Disable Reasoning</span>
                                    <span class="detail-value">
                                        ${capabilities.canTurnOffReasoning ? 
                                            '<span class="indicator indicator-yes"><i class="fas fa-check"></i> Yes</span>' : 
                                            '<span class="indicator indicator-no"><i class="fas fa-times"></i> No</span>'}
                                    </span>
                                </div>
                            `;
                        }
                        
                        if (capabilities.canIOReasoning !== undefined) {
                            html += `
                                <div class="model-detail">
                                    <span class="detail-label">Reasoning I/O Support</span>
                                    <span class="detail-value">
                                        ${capabilities.canIOReasoning ? 
                                            '<span class="indicator indicator-yes"><i class="fas fa-check"></i> Yes</span>' : 
                                            '<span class="indicator indicator-no"><i class="fas fa-times"></i> No</span>'}
                                    </span>
                                </div>
                            `;
                        }
                        
                        if (capabilities.reasoningSliderType) {
                            html += `
                                <div class="model-detail">
                                    <span class="detail-label">Reasoning Control</span>
                                    <span class="detail-value">
                                        ${capabilities.reasoningSliderType === 'budget_slider' ? 
                                            `Token Budget (${capabilities.reasoningBudgetMin}-${capabilities.reasoningBudgetMax})` :
                                            `Effort Level (${capabilities.reasoningEffortValues ? capabilities.reasoningEffortValues.join(', ') : ''})`}
                                    </span>
                                </div>
                            `;
                        }
                        
                        if (capabilities.thinkTags) {
                            html += `
                                <div class="model-detail">
                                    <span class="detail-label">Think Tags</span>
                                    <span class="detail-value">${capabilities.thinkTags[0]}, ${capabilities.thinkTags[1]}</span>
                                </div>
                            `;
                        }
                    }
                }
                
                html += `
                    <div class="model-detail">
                        <span class="detail-label">System Messages</span>
                        <span class="detail-value">
                            ${capabilities.supportsSystemMessage ? 
                                `<span class="indicator indicator-yes"><i class="fas fa-check"></i> ${capabilities.supportsSystemMessage}</span>` : 
                                '<span class="indicator indicator-no"><i class="fas fa-times"></i> No</span>'}
                        </span>
                    </div>
                `;
                
                // Add tool format if available
                if (capabilities.specialToolFormat) {
                    html += `
                        <div class="model-detail">
                            <span class="detail-label">Tool Format</span>
                            <span class="detail-value">${capabilities.specialToolFormat}</span>
                        </div>
                    `;
                }
                
                // Enhanced cost information display
                if (capabilities.cost) {
                    const costInfo = capabilities.cost;
                    
                    html += `
                        <div class="model-detail">
                            <span class="detail-label">Cost per Million Tokens</span>
                            <div class="costs">
                    `;
                    
                    if (costInfo.input !== undefined) {
                        html += costInfo.input === 0 ? 
                            '<span class="cost-item cost-free"><i class="fas fa-tag"></i> Free</span>' : 
                            `<span class="cost-item">Input: $${costInfo.input.toFixed(2)}</span>`;
                    }
                    
                    if (costInfo.output !== undefined && costInfo.output !== 0) {
                        html += `<span class="cost-item">Output: $${costInfo.output.toFixed(2)}</span>`;
                    }
                    
                    if (costInfo.cacheRead !== undefined && costInfo.cacheRead !== 0) {
                        html += `<span class="cost-item">Cache Read: $${costInfo.cacheRead.toFixed(2)}</span>`;
                    }
                    
                    if (costInfo.cacheWrite !== undefined && costInfo.cacheWrite !== 0) {
                        html += `<span class="cost-item">Cache Write: $${costInfo.cacheWrite.toFixed(2)}</span>`;
                    }
                    
                    html += `
                            </div>
                        </div>
                    `;
                }
            } else {
                html += `<div class="model-detail">No detailed capabilities information available</div>`;
            }
            
            html += `
                    </div>
                </div>
            `;
        }
        
        html += `
                    </div>
                </div>
            </div>
        `;
    }
    
    return html;
}

// Helper function to format numbers with commas for thousands
function formatNumber(num) {
    if (typeof num !== 'number') return num;
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Helper function to format provider names
function formatProviderName(name) {
    const specialCases = {
        openAI: "OpenAI",
        xAI: "X.AI",
        vLLM: "vLLM",
        openAICompatible: "OpenAI Compatible"
    };
    
    if (specialCases[name]) return specialCases[name];
    
    // Capitalize first letter, handle camelCase
    return name.replace(/([A-Z])/g, ' $1')
        .replace(/^./, str => str.toUpperCase());
}

// Start the server
app.listen(PORT, () => {
    log(`Server is running on http://localhost:${PORT}`);
    console.log(`Open your browser to http://localhost:${PORT} to view the data`);
});