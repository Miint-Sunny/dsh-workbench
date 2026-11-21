/** 设计页与不可信画板之间的数据字段。所有值仅供展示和用户确认。 */
export const DESIGN_LIMITS={maxMessageBytes:8192,maxSelector:2048,maxStyleValue:256,maxComments:30,maxText:4000,maxParams:24,maxHtmlBytes:50331648,bridgeReadyMs:2500}
export const DESIGN_STYLES=['font-size','line-height','font-weight','color','background-color','letter-spacing','padding-top','padding-right','padding-bottom','padding-left','border-radius','display']
export const DESIGN_BOARDS={desktop:{width:1280,height:800,x:0},mobile:{width:375,height:812,x:1328}}
export function designFail(code){const error=new Error(code);error.code=code;throw error}
export function designConfig(input={}){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(DESIGN_LIMITS,k)))designFail('invalid-config');const out={...DESIGN_LIMITS,...input};for(const[k,v]of Object.entries(out))if(!Number.isSafeInteger(v)||v<1||v>DESIGN_LIMITS[k]*8)designFail('invalid-config');if(out.maxComments*240+256>out.maxMessageBytes)designFail('invalid-config');return out}
function designObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function designText(value,max,empty=false){return typeof value==='string'&&value.length<=max&&(empty||value.trim().length>0)&&!/[\u0000]/.test(value)}
/** 声明只接受数字与十六进制颜色，不把任意 CSS 文本当作参数。 */
export function designDeclarations(html,limits=DESIGN_LIMITS){
 const matches=[];let cursor=0
 while(cursor<html.length){const start=html.indexOf('<',cursor);if(start<0)break;cursor=start+1
  if(html.slice(start,start+7).toLowerCase()!=='<script'||!/[\s>]/.test(html[start+7]??''))continue
  const tagEnd=html.indexOf('>',start+7);if(tagEnd<0)break
  const closing=/<\/script\s*>/gi;closing.lastIndex=tagEnd+1;const end=closing.exec(html);if(!end)break;cursor=closing.lastIndex
  if(tagEnd-start>4096)continue
  const attributes=html.slice(start+7,tagEnd)
  if(/\bid\s*=\s*["']dsh-design-parameters["']/i.test(attributes)&&/\btype\s*=\s*["']application\/json["']/i.test(attributes))matches.push([null,attributes,html.slice(tagEnd+1,end.index)])
 }
 if(!matches.length)return[]
 if(matches.length!==1||matches[0][2].length>limits.maxParams*2048)designFail('invalid-parameters')
 let values;try{values=JSON.parse(matches[0][2])}catch{designFail('invalid-parameters')}
 if(!Array.isArray(values)||values.length>limits.maxParams)designFail('invalid-parameters')
 const names=new Set()
 return values.map(row=>{if(!designObject(row)||!/^--[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.name)||names.has(row.name)||!designText(row.label,80)||!['number','color'].includes(row.type))designFail('invalid-parameters');names.add(row.name)
  if(Object.keys(row).some(k=>!['name','label','type','min','max','step','unit','default'].includes(k)))designFail('invalid-parameters')
  if(row.type==='number'&&(![row.min,row.max,row.step].every(Number.isFinite)||row.min>=row.max||row.step<=0||!['','px','rem','em','%','deg'].includes(row.unit)))designFail('invalid-parameters')
  const normalized={...row};designValues({[row.name]:row.default},[normalized]);return normalized
 })
}
export function designValues(values,declarations){
 if(!designObject(values))designFail('invalid-parameters');const output={}
 for(const[name,value]of Object.entries(values)){const d=declarations.find(p=>p.name===name);if(!d)designFail('invalid-parameters')
  if(d.type==='color'){if(typeof value!=='string'||!/^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value))designFail('invalid-parameters')}
  else if(!Number.isFinite(value)||value<d.min||value>d.max||Math.abs((value-d.min)/d.step-Math.round((value-d.min)/d.step))>1e-7)designFail('invalid-parameters')
  output[name]=value
 }return output
}
export function designCSSValues(values,declarations){return Object.fromEntries(Object.entries(designValues(values,declarations)).map(([k,v])=>[k,String(v)+(declarations.find(d=>d.name===k).type==='number'?declarations.find(d=>d.name===k).unit:'')]))}
function designSelection(value,limits,position=false){
 if(!designObject(value)||!(position&&value.selector===null)&&!designText(value.selector,limits.maxSelector)||!designText(value.tag??'',40,true)||!designObject(value.rect)||!designObject(value.styles))designFail('invalid-selection')
 for(const key in value.rect)if(!['x','y','width','height'].includes(key))designFail('invalid-selection')
 const rect={};for(const k of ['x','y','width','height']){const n=value.rect[k];if(!Number.isFinite(n)||Math.abs(n)>1e6||(['width','height'].includes(k)&&n<0))designFail('invalid-selection');rect[k]=n}
 const styles={};for(const k in value.styles){const v=value.styles[k];if(!DESIGN_STYLES.includes(k)||!designText(v,limits.maxStyleValue,true)||/url\s*\(|expression|[;<>{}]/i.test(v))designFail('invalid-selection');styles[k]=v}
 return{selector:value.selector,tag:value.tag??'',rect,styles}
}
/** event.source 在调用本函数之前由父窗口核对；同帧脚本仍可伪造这些纯数据。 */
export function designMessage(value,expected,limits=DESIGN_LIMITS){
 try{
  if(!designObject(value)||value.nonce!==expected.nonce||value.board!==expected.board||value.version!==expected.version)return null
  const keys={ready:[],escape:[],error:['code'],selection:['selection'],locations:['locations','probe']}[value.type]
  if(!keys)return null
  for(const key in value)if(!['type','nonce','board','version',...keys].includes(key))return null
  let result
  if(value.type==='ready'||value.type==='escape')result={type:value.type}
  else if(value.type==='error')result=['script','csp'].includes(value.code)?{type:'error',code:value.code}:null
  else if(value.type==='selection'){
   if(!designObject(value.selection))return null
   for(const key in value.selection)if(!['selector','tag','rect','styles'].includes(key))return null
   const selection=designSelection(value.selection,limits)
   if(new TextEncoder().encode(selection.selector).length>limits.maxSelector)return null
   result={type:'selection',selection}
  }else if(value.type==='locations'&&Array.isArray(value.locations)&&value.locations.length<=limits.maxComments){
   if(value.probe!==undefined&&!designText(value.probe,64))return null
   const locations=[]
   for(const p of value.locations){if(!designObject(p)||!designText(p.id,64)||typeof p.valid!=='boolean')return null;for(const key in p)if(!['id','valid','rect'].includes(key))return null;locations.push(p.valid?{id:p.id,valid:true,rect:designSelection({selector:null,tag:'',styles:{},rect:p.rect},limits,true).rect}:{id:p.id,valid:false})}
   result={type:'locations',...(designText(value.probe,64)?{probe:value.probe}:{}),locations}
  }
  if(!result||new TextEncoder().encode(JSON.stringify({...expected,...result})).length>limits.maxMessageBytes)return null
  return result
 }catch{return null}
}

export function designDraft(value,declarations,limits=DESIGN_LIMITS){
 if(!designObject(value)||Object.keys(value).some(k=>!['comments','params'].includes(k))||!Array.isArray(value.comments)||value.comments.length>limits.maxComments)designFail('invalid-draft')
 const ids=new Set();const comments=value.comments.map(row=>{if(!designObject(row)||!designText(row.id,64)||ids.has(row.id)||!Object.hasOwn(DESIGN_BOARDS,row.board)||!designText(row.text,limits.maxText))designFail('invalid-draft');ids.add(row.id);return{id:row.id,board:row.board,...designSelection(row,limits,true),text:row.text}})
 return{comments,params:designValues(value.params??{},declarations)}
}
