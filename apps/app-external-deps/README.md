# Acurast App with External Dependencies Example

This project demonstrates how to write a simple Acurast App that depends on modules other than Node.js or Acurast build-ins.

## App Runtime Environment

Acurast processors run **Node.js v18.17.1**.

It's important to ensure that any app deployed to the processors is compatible with this version of Node.js. Please make sure that your apps adhere to this requirement to ensure proper execution within the Acurast environment.

## Overview

The project is a simple [TypeScript](https://www.typescriptlang.org/) app that depends on the [bn.js](https://github.com/indutny/bn.js) library. It uses [webpack](https://webpack.js.org/) to transpile TypeScript to JavaScript and bundle the code with its dependencies so that it can be deployed on Acurast processors.

#### Files
- `src/index.ts`: main file

## Usage

To deploy the app:

1. Set your API endpoint in `src/index.ts` by replacing the placeholder:
```typescript
const API_ENDPOINT = '<YOUR_API_ENDPOINT>';
```

The app will use this endpoint to send the result of its execution:
```
HTTP POST { "result": <text> }
```

2. Bundle the project:
```bash
$ npm run bundle
```

3. Navigate to `./dist` and copy the contents of `index.bundle.js`.

4. Use the copied content to create an Acurast deployment with [Acurast Console](https://console.acurast.com/).

