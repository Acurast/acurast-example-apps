# Acurast Example Apps

This repository contains example apps that can be deployed to the Acurast Cloud. These apps are designed to demonstrate various functionalities and features of Acurast, helping you to get started quickly with your own projects.

## Overview

An overview of the examples available in this repository.

| Project                                                                                           | Description                                                   | Features                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| [cargo](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo)                 | Run a non-Node.js workload using the Shell runtime            | Shell, Python, Cargo, CLI          |
| [env-vars](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-env-vars)           | Use secret environment variables in your deployments          | TS, CLI, Environment Variables     |
| [external-deps](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-external-deps) | A simple example to show how to include external dependencies | TS                                 |
| [fetch](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-fetch)                 | Use fetch to get data from an API and post it to another API  | TS, CLI, Acurast Runtime Variables |
| [heic-to-png](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-heic-to-png)     | Convert HEIC images to PNG                                    | TS, CLI                            |
| [llm](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-llm)                     | Run an LLM on Acurast                                         | TS, CLI, LLM Server, Webserver     |
| [p2p](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-p2p)                     | Connect to a processor over a P2P network                     | TS, CLI, P2P                       |
| [puppeteer](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-puppeteer)         | Scrape the web using Puppeteer                                | TS, CLI, Multiple Deployments      |
| [telegram-bot](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-telegram-bot)   | Run a telegram-bot                                            | TS, CLI                            |
| [tunnel](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-tunnel)               | Expose a local service to the public internet                 | TS, Cargo, CLI, P2P                |
| [wasm](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-wasm)                   | Run wasm                                                      | TS, CLI, WASM                      |
| [webserver](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-webserver)         | Run a webserver                                               | TS, CLI, Webserver                 |

### Programming Languages

Acurast's Shell (Cargo) runtime can run any language, not just Node.js. Each
example below sets up a `proot-distro` rootfs, installs the language toolchain,
then runs a minimal program that POSTs a JSON payload to a webhook. Use them as
starting points for your own workloads in the language of your choice.

| Project                                                                                         | Language |
| ----------------------------------------------------------------------------------------------- | -------- |
| [cargo-cpp](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-cpp)       | C++      |
| [cargo-csharp](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-csharp) | C#       |
| [cargo-go](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-go)         | Go       |
| [cargo-java](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-java)     | Java     |
| [cargo-nodejs](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-nodejs) | Node.js  |
| [cargo-php](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-php)       | PHP      |
| [cargo-python](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-python) | Python   |
| [cargo-ruby](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-ruby)     | Ruby     |
| [cargo-rust](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-rust)     | Rust     |
| [cargo-zig](https://github.com/Acurast/acurast-example-apps/tree/main/apps/app-cargo-zig)       | Zig      |

### Benchmarks

The [`apps/benchmarks/`](https://github.com/Acurast/acurast-example-apps/tree/main/apps/benchmarks)
directory contains a small study comparing the runtime options on Acurast: the same workload
run in the native JS runtime, in Node inside a proot container, and as native Rust inside a
proot container — plus the tooling to collect and visualize the results. See
[`apps/benchmarks/README.md`](https://github.com/Acurast/acurast-example-apps/tree/main/apps/benchmarks)
for the apps, how to run them, and the findings.

### External Projects

This list contains apps by other projects and the community. Feel free to open a PR to add yours!

| Project                                                             | Description                                                                                                                               | Features                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [tzbtc](https://github.com/Acurast/acurast-tzbtc-script)            | An advanced Acurast app used by [tzbtc.io](https://tzbtc.io). tzBTC delivers the power of Bitcoin as a token to the world of blockchains. | TS, Websocket, BTC, Tezos, Unit Tests |
| [acelon](https://github.com/acelonoracle/acelon-oracle)             | An advanced Acurast app that is used to build a reliable oracle service                                                                   | TS, Websocket                         |
| [aleph-zero-ink](https://github.com/Acurast/aleph-zero-example-app) | An app that interacts with an ink! contract on Aleph Zero                                                                                 | TS, Substrate                         |

## Acurast CLI

Most of the examples use the Acurast CLI. To get started, check out the [readme here](https://github.com/Acurast/acurast-cli).

## Acurast App API

For detailed documentation on the API and available functionalities for writing apps for Acurast processors, please refer to the [Acurast App API Documentation](https://docs.acurast.com/developers/job-runtime-environment/).

## App Runtime Environment

Acurast processors run **Node.js v20**.

It's important to ensure that any app deployed to the processors is compatible with this version of Node.js. Please make sure that your apps adhere to this requirement to ensure proper execution within the Acurast environment.
