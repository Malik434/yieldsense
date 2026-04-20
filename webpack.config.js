import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  mode: "production",
  entry: {
    index: "./src/index.ts",
    processor: "./src/processor.ts"
  },
  target: "node", // Important for Acurast environment
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
    extensionAlias: {
      ".js": [".js", ".ts"],
    },
  },
  output: {
    filename: "[name].bundle.cjs",
    path: path.resolve(__dirname, "dist"),
    libraryTarget: "commonjs",
    clean: {
      // Only clean the bundle outputs — leave hand-written dist/*.js files alone
      keep: /^(?!(?:index|processor)\.bundle)/,
    },
  },
};
