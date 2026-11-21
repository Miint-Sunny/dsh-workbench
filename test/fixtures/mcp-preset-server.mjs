/** Local protocol fixture: no credentials, files, or network requests. */
import { createInterface } from 'node:readline'
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result = {}
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'preset-fixture', version: '1.0.0' } }
  if (request.method === 'tools/list') result = { tools: [{ name: 'probe', description: 'Local test tool.', inputSchema: { type: 'object', properties: {} } }] }
  if (request.method === 'resources/list') result = { resources: [] }
  if (request.method === 'resources/templates/list') result = { resourceTemplates: [] }
  if (request.method === 'prompts/list') result = { prompts: [] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
