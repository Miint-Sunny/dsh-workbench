import { pagesActiveContent } from './pages-scripts.js'
import { passivePageHtml } from './pages-csp.js'
import { DESIGN_STYLES } from './design-protocol.js'
/** 固定画板脚本；页面发回的字段始终是不可信展示数据。 */
export function designBridgeRuntime(config){
 const script=document.currentScript,nonce=script.dataset.channel,board=script.dataset.board,version=Number(script.dataset.version)
 let mode='select',pins=[],selected,outline
 const send=(type,data={})=>parent.postMessage({type,nonce,board,version,...data},'*')
 function target(selector){try{const all=document.querySelectorAll(selector);return all.length===1?all[0]:null}catch{return null}}
 function selectorOf(element){if(element.id){const selector='#'+globalThis.CSS.escape(element.id);if(target(selector)===element)return selector}const path=[];let node=element;for(let depth=0;node&&depth<12;depth++,node=node.parentElement){let index=1;for(let sibling=node.previousElementSibling;sibling;sibling=sibling.previousElementSibling)if(sibling.tagName===node.tagName)index++;path.unshift(globalThis.CSS.escape(node.localName)+':nth-of-type('+index+')');const selector=path.join(' > ');if(selector.length<=config.maxSelector&&target(selector)===element)return selector}return null}
 function details(element,selector){const r=element.getBoundingClientRect(),computed=getComputedStyle(element),styles={};for(const name of config.styles){const value=computed.getPropertyValue(name);if(value.length<=config.maxStyleValue&&!/url\s*\(|expression|[;<>{}]/i.test(value))styles[name]=value}return{selector,tag:element.localName.slice(0,40),rect:{x:r.x,y:r.y,width:r.width,height:r.height},styles}}
 function locations(probe){send('locations',{...(typeof probe==='string'?{probe}:{}),locations:pins.map(pin=>{if(pin.selector===null)return{id:pin.id,rect:pin.rect,valid:true};const node=target(pin.selector);return node?{id:pin.id,valid:true,rect:details(node,pin.selector).rect}:{id:pin.id,valid:false}})})}
 document.addEventListener('selectstart',event=>event.preventDefault(),true)
 document.addEventListener('dragstart',event=>event.preventDefault(),true)
 document.addEventListener('click',event=>{if(mode!=='select'||!(event.target instanceof Element))return;event.preventDefault();event.stopImmediatePropagation();const selector=selectorOf(event.target);if(!selector)return;if(selected){selected.style.setProperty('outline',outline.value,outline.priority)}selected=event.target;outline={value:selected.style.getPropertyValue('outline'),priority:selected.style.getPropertyPriority('outline')};const value=details(selected,selector);selected.style.outline='2px solid #5687cf';send('selection',{selection:value})},true)
 window.addEventListener('message',event=>{const data=event.data;if(event.source!==parent||!data||data.nonce!==nonce||data.board!==board||data.version!==version)return
  if(data.type==='mode'&&['select','pan','position'].includes(data.mode))mode=data.mode
  if(data.type==='pins'&&Array.isArray(data.pins)&&data.pins.length<=config.maxComments){pins=data.pins;locations()}
  if(data.type==='params'&&data.values&&typeof data.values==='object'){for(const[name,value]of Object.entries(data.values))if(config.names.includes(name)&&typeof value==='string'&&value.length<128&&!/[;<>{}]|url\s*\(/i.test(value))document.documentElement.style.setProperty(name,value);locations()}
  if(data.type==='locate')locations(data.probe)
 })
 window.addEventListener('keydown',event=>{if(event.key==='Escape')send('escape')});
 window.addEventListener('resize',locations);window.addEventListener('scroll',locations,true)
 window.addEventListener('error',()=>send('error',{code:'script'}));document.addEventListener('securitypolicyviolation',()=>send('error',{code:'csp'}))
 send('ready')
}
/** nonce、画板与版本由宿主 UI 生成；声明名称在参数校验后才能进入配置。 */
export function designFrameHTML(html,{nonce,board,version,declarations,limits}){
  const config = {
    styles: DESIGN_STYLES, maxSelector: limits.maxSelector, maxStyleValue: limits.maxStyleValue,
    maxComments: limits.maxComments, names: declarations.map(declaration => declaration.name),
  }
  const passive = !pagesActiveContent(html)
  const bridgeNonce = passive ? crypto.randomUUID() : undefined
  const source = passive ? passivePageHtml(html, bridgeNonce) : html
  const nonceAttr = passive ? ' nonce="' + bridgeNonce + '"' : ''
  const code = '(' + designBridgeRuntime.toString() + ')(' + JSON.stringify(config).replaceAll('<', '\\u003c') + ');'
  const script = '<script' + nonceAttr + ' id="dsh-design-bridge" data-channel="' + nonce + '" data-board="' + board + '" data-version="' + version + '">' + code + '</script>'
  return source + script
}
