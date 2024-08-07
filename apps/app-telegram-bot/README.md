# Acurast Example App: Telegram Bot

This repository shows how to set up and run a project on Acurast.

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

This will create the file `dist/bundle.js`.

> [!TIP]
> Run `node dist/bundle.js` to check if the app works on your computer

### Deployment on Acurast

Head over to https://console.acurast.com/create and copy the contents of the file `dist/bundle.js` into the code field and deploy the app.

> [!NOTE]
> We will soon introduce the Acurast CLI. With the CLI, you will be able to deploy the app from within your IDE. Stay tuned for updates around the CLI!
