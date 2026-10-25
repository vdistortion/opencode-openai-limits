import { transformAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)
const out = new URL("dist/", root)
await mkdir(out, { recursive: true })

for (const name of await readdir(new URL("src/", root))) {
  if (!/\.tsx?$/.test(name) || name.endsWith(".test.ts")) continue
  const filename = fileURLToPath(new URL(`src/${name}`, root))
  const result = await transformAsync(await readFile(filename, "utf8"), {
    filename,
    configFile: false,
    babelrc: false,
    presets: [
      ...(name.endsWith(".tsx") ? [[solid, { moduleName: "@opentui/solid", generate: "universal" }]] : []),
      typescript,
    ],
    plugins: [() => ({ visitor: {
      ImportDeclaration(path) {
        if (path.node.source.value.startsWith(".")) {
          path.node.source.value = path.node.source.value.replace(/\.tsx?$/, ".js")
        }
      },
    } })],
  })
  if (!result?.code) throw new Error(`No build output for ${name}`)
  await writeFile(new URL(name.replace(/\.tsx?$/, ".js"), out), result.code + "\n")
}

// Local-directory discovery uses root entrypoints; package resolution uses exports.
await writeFile(new URL("index.js", root), 'export { default } from "./dist/index.js"\n')
await writeFile(new URL("tui.js", root), 'export { default } from "./dist/tui.js"\n')
