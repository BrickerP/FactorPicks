import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { underwritingInput } from './fixtures/underwriting-fixture.js'

function run(args, input = '', cwd = process.cwd()) {
  return new Promise(resolve => {
    const script = join(process.cwd(), 'scripts/derive-structured-underwriting.js')
    const child = spawn(process.execPath, [script, ...args], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('underwriting CLI accepts stdin and one local file', async () => {
  const serialized = JSON.stringify(underwritingInput())
  const stdinResult = await run(['-'], serialized)
  assert.equal(stdinResult.code, 0)
  assert.equal(JSON.parse(stdinResult.stdout).underwriting.longTermGate, 'PASS')
  const implicitStdin = await run([], serialized)
  assert.equal(implicitStdin.code, 0)
  assert.equal(JSON.parse(implicitStdin.stdout).underwriting.symbol, 'AAA')
  assert.doesNotMatch(implicitStdin.stdout, /buyAction|order|ledger/i)
  const dir = await mkdtemp(join(tmpdir(), 'factorpicks-underwriting-'))
  const file = join(dir, 'input.json')
  await writeFile(file, serialized)
  const fileResult = await run([file])
  assert.equal(fileResult.code, 0)
  assert.equal(JSON.parse(fileResult.stdout).underwriting.symbol, 'AAA')
})

test('underwriting CLI errors are generic and never echo private payloads', async () => {
  const secret = 'private-claim-and-source-token'
  for (const result of [await run([], `{ "claim": "${secret}"`),
    await run(['one.json', 'two.json'], secret)]) {
    assert.notEqual(result.code, 0)
    assert.equal(result.stderr, 'Structured underwriting input is invalid\n')
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret))
  }
})

test('underwriting CLI leaves an isolated working tree unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factorpicks-underwriting-side-effects-'))
  const before = await readdir(dir)
  const result = await run([], JSON.stringify(underwritingInput()), dir)
  const after = await readdir(dir)
  assert.equal(result.code, 0)
  assert.deepEqual(after, before)
})
