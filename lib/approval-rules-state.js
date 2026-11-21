/** 放行规则的数据语义：严格 argv、有限可选参数与固定项目/程序身份。 */
import{isAbsolute,basename}from'node:path'
export function rulesFail(code){const error=new Error(code);error.code=code;throw error}
export function parseApprovalRulesConfig(input={}){
 const defaults={maxRules:128,maxPending:128,maxCommandChars:8192,maxArgs:128,maxStateBytes:1048576,maxProgramBytes:67108864,maxFingerprintCache:32,maxConcurrentChecks:2,maxAuditBytes:16777216,lookupTimeoutMs:3000,executableRoots:process.platform==='darwin'?['/bin','/usr/bin','/sbin','/usr/sbin','/Library/Developer/CommandLineTools/usr/bin','/Applications/Xcode.app/Contents/Developer/usr/bin','/opt/homebrew/Cellar','/usr/local/Cellar','/opt/homebrew/bin','/usr/local/bin']:['/bin','/usr/bin','/sbin','/usr/sbin']}
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults,k)))rulesFail('invalid-config')
 const value={...defaults,...input};for(const key of Object.keys(defaults).filter(k=>k!=='executableRoots'))if(!Number.isSafeInteger(value[key])||value[key]<1||value[key]>defaults[key]*16)rulesFail('invalid-config')
 if(!Array.isArray(value.executableRoots)||value.executableRoots.length>32||!value.executableRoots.length||value.executableRoots.some(p=>typeof p!=='string'||!isAbsolute(p)))rulesFail('invalid-config')
 return value
}
export function simpleArgv(command,config={maxCommandChars:8192,maxArgs:128}){
 if(typeof command!=='string'||!command.trim()||command.length>config.maxCommandChars||/[\u0000-\u001f\u007f;&|<>$\x60\\'"*?\[\]{}()~!]/.test(command))rulesFail('not-simple')
 const argv=command.trim().split(/ +/)
 if(argv.length>config.maxArgs||argv.some(s=>!/^[A-Za-z0-9_./:@%+,=\-]+$/.test(s))||argv[0].includes('='))rulesFail('not-simple')
 if(argv.some(s=>/^--?(?:.*(?:password|secret|token|credential).*)$/i.test(s)||/^authorization:/i.test(s)))rulesFail('sensitive-arguments')
 return argv
}
/** 通用命令固定全部参数；git status 可明确选择两个无值尾参数。 */
export function approvalPattern(argv){
 const args=argv.slice(1)
 if(basename(argv[0])==='git'&&args[0]==='status'&&args.slice(1).every(a=>['--short','--branch'].includes(a))&&new Set(args.slice(1)).size===args.length-1)return{fixed:['status'],required:args.slice(1),offered:['--short','--branch']}
 return{fixed:args,required:[],offered:[]}
}
export function patternMatches(pattern,args){return args.length>=pattern.fixed.length&&pattern.fixed.every((a,i)=>args[i]===a)&&args.slice(pattern.fixed.length).every(a=>pattern.optional.includes(a))&&new Set(args.slice(pattern.fixed.length)).size===args.length-pattern.fixed.length}
export function ruleMatches(rule,candidate){return rule.enabled&&rule.projectKey===candidate.project.key&&rule.cwd===candidate.cwd&&rule.identity===candidate.identity&&patternMatches(rule.pattern,candidate.argv.slice(1))}
export function choosePattern(proposal,options){
 if(!Array.isArray(options)||options.length>proposal.offered.length||options.some(v=>!proposal.offered.includes(v))||new Set(options).size!==options.length||proposal.required.some(v=>!options.includes(v)))rulesFail('invalid-options')
 return{fixed:proposal.fixed,optional:[...options].sort()}
}
