const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: "./src/index.jsx",
  output: {
    filename: "bundle.js",
    path: path.resolve(__dirname, "dist"),
    publicPath: "./",
    clean: true,
  },
  resolve: {
    extensions: [".js", ".jsx"],
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: ["@babel/preset-env", "@babel/preset-react"],
          },
        },
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: "index.html",
          to: "index.html",
          transform(content) {
            // dist/index.html must load ./bundle.js (relative, CEP file:// safe).
            // Handle both source variants: src="dist/bundle.js" and src="./dist/bundle.js".
            return content
              .toString()
              .replace('src="./dist/bundle.js"', 'src="./bundle.js"')
              .replace('src="dist/bundle.js"', 'src="./bundle.js"');
          },
        },
        { from: "CSXS/manifest.xml", to: "CSXS/manifest.xml" },
        { from: "jsx/host.jsx", to: "jsx/host.jsx" },
        { from: ".debug", to: ".debug", toType: "file" },
      ],
    }),
  ],
  // UXP runtime exposes these as globals — do NOT bundle them
  externals: {
    premierepro: "premierepro",
    uxp: "uxp",
  },
};
