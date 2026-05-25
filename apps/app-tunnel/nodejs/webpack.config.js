const { resolve } = require("path");

module.exports = {
    entry: './src/index.ts',
    mode: 'production',
    output: {
        filename: 'bundle.js',
        path: resolve(__dirname, 'dist'),
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    ignoreWarnings: [
        {
            module: /node_modules\/ws\//,
            message: /Can't resolve '(bufferutil|utf-8-validate)'/,
        },
    ],
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    target: "node"
}
