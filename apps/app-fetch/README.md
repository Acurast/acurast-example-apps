# Acurast Example App: Fetch

This repository shows how to set up and run a project with fetch on Acurast.

## Setup

### Requirements

To set up this project on your computer, make sure to have `node.js` installed. Then run

```bash
npm i
```

### Build and Bundle

To build and bundle the project into a single executable, run

```bash
npm run bundle
```

This will create the file `./dist/bundle.js`.

> [!TIP]
> Run `node ./dist/bundle.js` to check if the app works on your computer

### Deployment on Acurast

#### Using the CLI

To use the acurast CLI, you need to add a .env file and add some secrets. Read more about how to use the CLI here: https://github.com/Acurast/acurast-cli

#### Using console.acurast.com

Head over to https://console.acurast.com/create and copy the contents of the file `./dist/bundle.js` into the code field and deploy the app.
