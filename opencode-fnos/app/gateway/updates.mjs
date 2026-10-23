export function mount(root) {
  root.replaceChildren()
  root.style.cssText='padding:28px;max-width:880px;overflow:auto;height:100%;color:inherit;font:inherit'
  const add=(tag,text,parent=root)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;parent.append(e);return e}
  add('h2','程序更新').style.cssText='font-size:20px;font-weight:600;margin-bottom:16px'
  add('p','直接下载官方 OpenCode 程序。先在临时实例检查兼容性，通过后自动备份配置与会话，再切换版本。界面不兼容时保留旧版，请等待新版飞牛安装包。')
  const info=add('p','正在读取…');info.style.margin='18px 0'
  const controls=add('div'), select=add('select',undefined,controls)
  select.setAttribute('aria-label','官方版本')
  select.style.cssText='padding:8px;background:transparent;color:inherit;border:1px solid #666;border-radius:6px;margin:0 12px 12px 0'
  const status=add('p','');status.setAttribute('role','status');status.style.cssText='white-space:pre-wrap;margin:16px 0'
  const notice=add('p','');notice.setAttribute('role','status');notice.style.cssText='white-space:pre-wrap;margin:12px 0'
  const note=add('p','更新或回退会中断正在生成的回复和终端。回退会恢复更新前的配置与会话数据，之后产生的会话变更不会出现在回退后的实例中；备份会保留。')
  note.style.cssText='font-size:13px;opacity:.75;line-height:1.7'
  let busy=false, querying=false, submitting=false, current, timer, failures=0, lastPhase
  const api=async(url,body)=>{
    const response=await fetch(window.__FNOS_OPENCODE__.prefix+'/_fnos/update/'+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined)
    const data=await response.json()
    if(!response.ok)throw new Error(data.error||'请求失败')
    return data
  }
  const button=(text,action)=>{
    const b=add('button',text,controls);b.type='button'
    b.style.cssText='padding:8px 14px;margin:0 10px 12px 0;border:1px solid #666;border-radius:6px;cursor:pointer'
    b.onclick=action;return b
  }
  const refreshButtons=()=>{
    const locked=busy||querying||submitting
    check.disabled=locked;apply.disabled=locked||!select.value||select.value===current?.current
    rollback.disabled=locked||!current?.canRollback;select.disabled=locked
  }
  async function readStatus(){
    try{
      current=await api('status');failures=0
      info.textContent=`当前官方程序：${current.current}　飞牛安装包：${current.package}　架构：${current.architecture}`
      busy=!['idle','complete','failed'].includes(current.phase)
      status.textContent=current.message||''
      if(current.phase==='complete' && lastPhase && lastPhase!=='complete')status.textContent+=' 请刷新整个窗口以加载新程序。'
      lastPhase=current.phase;refreshButtons()
    }catch{
      failures++
      status.textContent=busy&&failures<60?'正在等待服务切换，请稍候…':'暂时无法连接服务器。请重新打开应用或查看日志。'
    }
  }
  const check=button('检查官方更新',async()=>{
    querying=true;refreshButtons();notice.textContent='正在查询官方版本…'
    try{
      const data=await api('releases');select.replaceChildren()
      for(const version of data.versions){const option=add('option',version,select);option.value=version}
      if(!data.versions.length)notice.textContent='暂未找到适合当前架构的官方正式版本。'
      else notice.textContent='请选择版本。能否独立更新，将在临时实例中检查。'
      await readStatus()
    }catch(error){notice.textContent=error.message}
    finally{querying=false;refreshButtons()}
  })
  const request=async body=>{
    submitting=true;busy=true;refreshButtons();notice.textContent='正在提交任务…'
    try{await api('request',body);notice.textContent='';await readStatus()}
    catch(error){notice.textContent=error.message;busy=false}
    finally{submitting=false;refreshButtons()}
  }
  const apply=button('更新到所选版本',()=>request({action:'apply',version:select.value}))
  const rollback=button('回退并恢复备份',()=>request({action:'rollback'}))
  select.onchange=refreshButtons
  const cli=add('details');add('summary','在聊天中发起更新',cli)
  add('p','可让 OpenCode 在终端工具中执行以下命令；更新在后台继续，当前聊天可能因重启暂时断开。',cli)
  add('pre','fnos-opencode-update check\nfnos-opencode-update apply 版本号\nfnos-opencode-update status\nfnos-opencode-update rollback',cli).style.cssText='white-space:pre-wrap;padding:12px;border:1px solid #555;border-radius:6px;margin-top:12px'
  refreshButtons();readStatus()
  timer=setInterval(()=>{if(!root.isConnected){clearInterval(timer);return}readStatus()},2000)
}
