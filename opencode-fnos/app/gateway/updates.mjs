export function mount(root) {
  root.replaceChildren()
  root.style.cssText='padding:28px;max-width:880px;overflow:auto;height:100%;color:inherit;font:inherit'
  const add=(tag,text,parent=root)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;parent.append(e);return e}
  add('h2','FN-OPENCODE 更新').style.cssText='font-size:20px;font-weight:600;margin-bottom:16px'
  add('p','检查飞牛适配版的新版本，下载对应设备的 FPK 后，在飞牛应用中心选择“手动安装”完成升级。')
  const info=add('p','正在读取当前版本…');info.style.margin='18px 0'
  const controls=add('div'), check=add('button','检查 FN-OPENCODE 更新',controls);check.type='button'
  check.style.cssText='padding:8px 14px;border:1px solid #666;border-radius:6px;cursor:pointer;margin:0 12px 12px 0'
  const page=add('a','打开项目发布页',controls)
  page.href='https://github.com/HANSHOJIN/FN-OPENCODE/releases';page.target='_blank';page.rel='noopener noreferrer'
  const status=add('p','');status.setAttribute('role','status');status.style.margin='16px 0'
  const details=add('div')
  const api=async name=>{
    const response=await fetch(window.__FNOS_OPENCODE__.prefix+'/_fnos/update/'+name)
    const data=await response.json()
    if(!response.ok)throw new Error(data.error||'更新查询失败。')
    return data
  }
  const showCurrent=data=>{info.textContent=`当前 FN-OPENCODE：${data.package}　内核：${data.current}　架构：${data.architecture}`}
  check.onclick=async()=>{
    check.disabled=true;status.textContent='正在查询 FN-OPENCODE 发布版本…';details.replaceChildren()
    try{
      const data=await api('releases');if(!root.isConnected)return
      showCurrent(data)
      status.textContent=data.hasUpdate?`发现新版本 ${data.latest.version}。`:'当前已是最新发布版本。'
      if(!data.latest){status.textContent='暂未找到适合当前架构的正式安装包。';return}
      if(!data.hasUpdate)return
      add('pre',data.latest.notes||'请查看项目发布页了解更新内容。',details).style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.7'
      const expected=`https://github.com/HANSHOJIN/FN-OPENCODE/releases/download/v${data.latest.version}/${data.latest.filename}`
      if(data.latest.url!==expected || !/^\d+\.\d+\.\d+(?:-[1-9]\d*)?$/.test(data.latest.version))throw new Error('安装包地址校验失败。')
      const download=add('a','下载 '+data.latest.filename,details)
      download.href=expected;download.target='_blank';download.rel='noopener noreferrer'
      download.style.cssText='display:inline-block;padding:10px 14px;border:1px solid #666;border-radius:6px;margin:12px 0'
      add('p','下载后请回到飞牛应用中心手动安装。',details)
    }catch(error){status.textContent=error.message;details.replaceChildren()}
    finally{check.disabled=false}
  }
  api('status').then(showCurrent).catch(()=>{info.textContent='当前版本暂时无法读取，请重新打开设置。'})
}
