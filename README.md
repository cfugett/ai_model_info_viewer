# AI Model Capabilities Viewer

A dynamic web application that provides a comprehensive overview of capabilities across different AI models and providers.

AI Model Capabilities Viewer

## Overview

The AI Model Capabilities Viewer extracts and presents detailed information about AI models from various providers. It parses structured data from the `modelCapabilities.ts` file in the [Void Editor](https://github.com/voideditor/void) repository, presenting it in an organized and searchable web interface.

## Key Features

- **Real-time Data**: Fetches the latest model information from GitHub on every refresh
- **Comprehensive Provider Coverage**: Displays data for 15+ model providers including OpenAI, Anthropic, Google (Gemini), Mistral, Groq, and more
- **Detailed Capability Information**: Shows key model characteristics including:
  - Context window size
  - Reserved output token space
  - Fill-in-Middle (FIM) support
  - Reasoning capabilities
  - System message support
  - Tool formats
  - Cost information
- **Search Functionality**: Quickly filter models or providers by name
- **Responsive Design**: Works across desktop and mobile devices

## Technical Details

### How It Works

1. The server fetches the latest `modelCapabilities.ts` file from the Void Editor GitHub repository
2. It parses the TypeScript file to extract structured data about AI models and providers
3. The data is organized by provider and presented in a clean, modern interface
4. Models are displayed in expandable cards with detailed capability information

### Architecture

- **Backend**: Node.js with Express
- **Frontend**: Pure HTML, CSS, and JavaScript (no frameworks)
- **Data Source**: GitHub raw content API

## Installation

### Prerequisites

- Node.js (v14.0.0 or higher)
- npm (v6.0.0 or higher)

### Setup

1. Clone the repository
   ```bash
   git clone https://github.com/yourusername/ai_model_info_viewer.git
   cd ai_model_info_viewer
   ```

2. Install dependencies
   ```bash
   npm install
   ```

3. Start the server
   ```bash
   node app.js
   ```

4. Open your browser and navigate to `http://localhost:3456`

## Configuration

The application tries multiple GitHub URLs to find the model data. If you need to change the source URLs, modify the `GITHUB_URLS` array in `app.js`.

```javascript
const GITHUB_URLS = [
    'https://raw.githubusercontent.com/voideditor/void/main/src/vs/workbench/contrib/void/common/modelCapabilities.ts',
    // Add alternative URLs here
];
```

## Usage

- **Browse by Provider**: Click on any provider card to see the models it offers
- **Search**: Use the search box to filter by model name, capability, or provider
- **View Details**: Each model card shows detailed capability information
- **View Raw Data**: Click the "View Raw Data" button to see the original TypeScript file

## Development

### File Structure

- `app.js` - Main application file with server setup and data parsing logic
- `package.json` - Project dependencies
- `.gitignore` - Files excluded from version control

### Logging

The application logs to both the console and a file (`app.log`) for easier debugging.

## Roadmap

- [ ] Add visual charts for model comparisons
- [ ] Implement model filtering by capability (e.g., show all models with reasoning support)
- [ ] Create API endpoints to access the parsed data
- [ ] Add version tracking to monitor changes in model capabilities over time

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the ISC License - see the LICENSE file for details.

## Acknowledgments

- Data sourced from the [Void Editor](https://github.com/voideditor/void) project
- Built with Express