import { compile } from "svelte/compiler";

Bun.plugin({
  name: "svelte-test-loader",
  setup(builder) {
    builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const { js } = compile(source, { filename: path, generate: "server" });
      return { contents: js.code, loader: "js" };
    });
  },
});
