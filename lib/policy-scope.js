/** 当前会话的预设排除和真实项目目录；不读取项目正文。 */
import {realpath} from 'node:fs/promises'
import {relative,isAbsolute} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
const policyGit=promisify(execFile)
export const policyHash=value=>createHash('sha256').update(value).digest('hex')
export const whalePreset=preset=>preset==='whale'||typeof preset==='string'&&preset.startsWith('whale-')
/** Git 工作树分别计项目；非 Git 使用包含当前目录的原工作区。 */
export async function policyProject(cwd,workspace,timeoutMs=3000,signal){
 const current=await realpath(cwd);let path=current
 if(workspace){const root=await realpath(workspace),rel=relative(root,current);if(rel===''||!rel.startsWith('..')&&!isAbsolute(rel))path=root}
 const env={...process.env,LC_ALL:'C'};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key]
 try{const{stdout}=await policyGit('git',['-C',current,'-c','core.hooksPath=/dev/null','rev-parse','--show-toplevel'],{env,timeout:timeoutMs,maxBuffer:65536,signal});path=await realpath(stdout.trim())}
 catch(error){if(error.code!==128||!error.stderr?.includes('not a git repository'))throw error}
 return{path,key:policyHash(path)}
}
