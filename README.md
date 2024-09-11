# Acurast Example Apps

This repository contains example apps that can be deployed to the Acurast Cloud. These apps are designed to demonstrate various functionalities and features of Acurast, helping you to get started quickly with your own projects.

## Overview

An overview of the examples available in this repository.

| Project                                                                                           | Description                                                   | Features                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| [env-vars](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-env-vars)           | Use secret environment variables in your deployments          | TS, CLI, Environment Variables     |
| [external-deps](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-external-deps) | A simple example to show how to include external dependencies | TS                                 |
| [fetch](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-fetch)                 | Use fetch to get data from an API and post it to another API  | TS, CLI, Acurast Runtime Variables |
| [puppeteer](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-puppeteer)         | Scrape the web using Puppeteer                                | TS, CLI, Multiple Deployments      |
| [telegram-bot](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-telegram-bot)   | Run a telegram-bot                                            | TS, CLI                            |
| [wasm](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-wasm)                   | Run wasm                                                      | TS, CLI, WASM                      |

### External Projects

This list contains apps by other projects and the community. Feel free to open a PR to add yours!

| Project                                                             | Description                                                                                                                               | Features                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [tzbtc](https://github.com/Acurast/acurast-tzbtc-script)            | An advanced Acurast app used by [tzbtc.io](https://tzbtc.io). tzBTC delivers the power of Bitcoin as a token to the world of blockchains. | TS, Websocket, BTC, Tezos, Unit Tests |
| [oracle-service](https://github.com/Acurast/acurast-oracle-service) | An advanced Acurast app that is used to build a reliable oracle service                                                                   | TS, Websocket                         |
| [aleph-zero-ink](https://github.com/Acurast/aleph-zero-example-app) | An app that interacts with an ink! contract on Aleph Zero                                                                                 | TS, Substrate                         |

## Acurast CLI

Most of the examples use the Acurast CLI. To get started, check out the [readme here](https://github.com/Acurast/acurast-cli).

## Acurast App API

For detailed documentation on the API and available functionalities for writing apps for Acurast processors, please refer to the [Acurast App API Documentation](https://docs.acurast.com/developers/job-runtime-environment/).

## App Runtime Environment

Acurast processors run **Node.js v18.17.1**.

It's important to ensure that any app deployed to the processors is compatible with this version of Node.js. Please make sure that your apps adhere to this requirement to ensure proper execution within the Acurast environment.
