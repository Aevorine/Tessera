import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativeHelpers = [
  {
    label: 'File hook',
    source: path.resolve(uiDir, '..', '..', '..', 'core', 'fileops', 'c', 'hook_agent.c'),
    output: path.resolve(uiDir, '..', '..', '..', 'core', 'fileops', 'c', 'hook_agent.exe'),
    args: ['-O2', '-municode', '-mwindows', '-luser32', '-lshell32'],
  },
  {
    label: 'Fingerprint verifier',
    source: path.resolve(uiDir, '..', 'c', 'fingerprint_verify.c'),
    output: path.resolve(uiDir, '..', 'c', 'fingerprint_verify.exe'),
    // -mwindows 不能少：否则产物是控制台子系统（PE Subsystem = WINDOWS_CUI），每次验指纹都会闪出黑框。
    // 判据是 PE 子系统必须为 WINDOWS_GUI(2)：读 PE 头偏移 +0x5C 的 UInt16（2=GUI 3=CUI）。
    // 必须在链接库参数之前：下面拼命令行用 slice(0,-2)/slice(-2) 把最后两个参数挪到源文件之后。
    args: ['-O2', '-Wall', '-Wextra', '-mwindows', '-lruntimeobject', '-lole32'],
  },
]

for (const helper of nativeHelpers) {
  let needsBuild = true
  try {
    needsBuild = statSync(helper.output).mtimeMs < statSync(helper.source).mtimeMs
  } catch {
    needsBuild = true
  }

  if (needsBuild) {
    const result = spawnSync('gcc', [
      ...helper.args.slice(0, -2),
      '-o',
      helper.output,
      helper.source,
      ...helper.args.slice(-2),
    ], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }

  console.log(`${helper.label} ready: ${helper.output}`)
}
