# Acurast Job with External Dependencies Example

This project demonstrates how to write a simple Acurast Job Script that depends on modules other than Node.js or Acurast build-ins.

## Job Runtime Environment

The script in this project is designed to be executed on Acurast processors, which run Node.js version 18.17.2. It's important to ensure that any script deployed to the processors is compatible with this version of Node.js. Please make sure that your scripts adhere to this requirement to ensure proper execution within the Acurast environment.

## Overview

The project is a simple [TypeScript](https://www.typescriptlang.org/) script that depends on the [bn.js](https://github.com/indutny/bn.js) library. It uses [webpack](https://webpack.js.org/) to create a bundle that can be deployed on Acurast processors.

#### Files
- `src/index.ts`: main file

## Usage

To deploy the script:

1. Bundle the project:
```bash
$ npm run bundle
```

2. Navigate to `./dist` and copy the contents of `index.bundle.js`.
3. Use the copied content to create a job with [Acurast Console](https://console.acurast.com/).

