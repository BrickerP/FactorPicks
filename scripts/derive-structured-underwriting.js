import { readFile } from 'node:fs/promises'
import { stdin, stdout, stderr } from 'node:process'
import { deriveStructuredUnderwriting } from '../src/domain/structuredUnderwriting.js'

async function readStdin() {
  const chunks = []
  for await (const chunk of stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1) throw new TypeError()
  const raw = !args.length || args[0] === '-' ? await readStdin() : await readFile(args[0], 'utf8')
  stdout.write(`${JSON.stringify(deriveStructuredUnderwriting(JSON.parse(raw)), null, 2)}\n`)
}

main().catch(() => {
  stderr.write('Structured underwriting input is invalid\n')
  process.exitCode = 1
})
