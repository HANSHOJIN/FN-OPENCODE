// Uses the native OpenCode configuration APIs through the authenticated gateway.
export function mount(root) {
  root.replaceChildren()
  root.style.cssText = 'padding:28px;max-width:900px;color:inherit;font:inherit;overflow:auto;height:100%'
  const node = (tag, text, parent = root) => {
    const result = document.createElement(tag)
    if (text !== undefined) result.textContent = text
    parent.append(result)
    return result
  }
  const button = (text, parent, click) => {
    const result = node('button', text, parent)
    result.type = 'button'
    result.style.cssText = 'padding:6px 14px;border:1px solid #555;border-radius:6px;cursor:pointer;margin:0 8px 12px 0'
    result.onclick = click
    return result
  }
  node('h2', '扩展').style.cssText = 'font-size:20px;font-weight:600;margin-bottom:8px'
  node('p', '管理飞牛服务器上的 MCP、插件和技能。配置可用于所有项目。').style.marginBottom = '20px'
  const tabs = node('div')
  const content = node('div')
  const status = node('p', '')
  status.setAttribute('role', 'status')
  status.style.cssText = 'white-space:pre-wrap;margin-top:16px'
  let current = 'MCP', generation = 0
  async function api(path, options) {
    const response = await fetch(window.__FNOS_OPENCODE__.prefix + path, options)
    if (!response.ok) throw new Error('请求失败（HTTP ' + response.status + '）')
    return response.json()
  }
  const message = text => { status.textContent = text }
  const editor = value => {
    const result = node('textarea', undefined, content)
    result.value = JSON.stringify(value, null, 2)
    result.spellcheck = false
    result.setAttribute('aria-label', current + ' 配置')
    result.style.cssText = 'display:block;width:100%;min-height:220px;padding:12px;margin:14px 0;background:#181818;color:#eee;border:1px solid #555;border-radius:6px;font:13px monospace;resize:vertical'
    return result
  }
  async function show(name) {
    current = name
    const ticket = ++generation
    for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.textContent === name))
    content.replaceChildren()
    message('正在读取…')
    try {
      if (name === '技能') {
        const skills = await api('/skill')
        if (ticket !== generation) return
        if (!Array.isArray(skills)) throw new Error('服务器返回了无法识别的技能列表')
        node('p', skills.length ? '已发现的技能' : '当前还没有技能', content)
        for (const skill of skills) {
          const item = node('div', undefined, content)
          item.style.cssText = 'margin:12px 0;padding:12px;border:1px solid #444;border-radius:6px'
          node('strong', skill.name, item)
          node('p', skill.description || '', item)
          node('code', skill.location || '', item).style.overflowWrap = 'anywhere'
        }
        node('p', '安装技能：全局技能放在 /var/apps/opencode-fnos/etc/opencode/skills/<名称>/SKILL.md；项目技能放在 .opencode/skills/<名称>/SKILL.md。安装文件后重启应用，再刷新列表。', content).style.marginTop = '18px'
        button('刷新技能列表', content, () => show(name))
        message(''); return
      }
      const config = await api('/global/config')
      if (ticket !== generation) return
      const field = name === 'MCP' ? 'mcp' : 'plugin'
      node('p', name === 'MCP'
        ? '编辑 MCP 服务配置。支持本地命令和远程服务；新增服务时请替换示例名称、命令或地址。'
        : '插件使用 npm 包名或服务器上的 file:// 地址；可填写版本号。每行内容应作为 JSON 数组中的一个字符串。', content)
      const example = name === 'MCP'
        ? { '示例服务': { type: 'remote', url: 'https://example.com/mcp', enabled: true } }
        : ['插件包名@版本']
      const hint = node('details', undefined, content)
      node('summary', '查看格式示例', hint)
      node('pre', JSON.stringify(example, null, 2), hint).style.whiteSpace = 'pre-wrap'
      const input = editor(config[field] ?? (name === 'MCP' ? {} : []))
      const actions = node('div', undefined, content)
      const save = button('保存配置', actions, async () => {
        try {
          const value = JSON.parse(input.value)
          if (field === 'mcp' && (!value || Array.isArray(value) || typeof value !== 'object')) throw new Error('MCP 配置必须是 JSON 对象')
          if (field === 'plugin' && (!Array.isArray(value) || !value.every(item => typeof item === 'string' || (Array.isArray(item) && typeof item[0] === 'string')))) throw new Error('插件配置必须是 JSON 数组，包含包名字符串或插件配置元组')
          save.disabled = true
          message('正在保存…')
          await api('/global/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }) })
          message('已保存。请新建会话使用更新后的扩展。')
        } catch (error) { message(error.message) }
        finally { save.disabled = false }
      })
      button('重新读取', actions, () => show(name))
      message('')
    } catch (error) { if (ticket === generation) message(error.message) }
  }
  tabs.setAttribute('role', 'tablist')
  for (const name of ['MCP', '插件', '技能']) button(name, tabs, () => show(name)).setAttribute('role', 'tab')
  void show('MCP')
}
