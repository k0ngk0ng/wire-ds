import http from 'node:http';

// Only the third-party service is replaced. Desktop behavior runs in actual Electron.
export async function startFixture() {
  const server = http.createServer((req, res) => {
    if (req.url === '/unavailable') { res.destroy(); return; }
    if (req.url === '/pending-widget') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<html><body>Pending widget'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DeepSeek test service</title>
    <style>[hidden]{display:none!important}*{box-sizing:border-box}body{margin:0;font:15px system-ui;color:#293046;background:#fff}aside{width:220px;background:#f7f8fb;padding:24px}main{padding:30px;flex:1}#chat{display:flex;min-height:100vh}textarea{width:100%;height:90px;padding:14px;border:1px solid #ddd;border-radius:14px;font:inherit}button{padding:9px 14px;border:1px solid #ddd;border-radius:8px;background:white;cursor:pointer}#messages{min-height:180px}dialog{border:1px solid #ddd;border-radius:12px}#login{max-width:340px;margin:70px auto}input{display:block;padding:10px;margin:10px 0;width:100%}@media(prefers-color-scheme:dark){body{color:#d8dde8;background:#151517}aside{background:#1c1f26}button,textarea,input{background:#25272c;color:#d8dde8;border-color:#3b3e46}}#messages{min-height:60px}</style></head><body>
    <section id="login" hidden><h1>登录 DeepSeek</h1><input aria-label="手机号或邮箱" placeholder="手机号或邮箱"><input type="password" aria-label="密码"><button id="sign-in">登录</button></section>
    <section id="chat" hidden><aside aria-label="历史对话"><button id="new">开启新对话</button><p>昨天的对话</p><button id="logout">退出登录</button></aside><main><button aria-label="收起侧边栏" id="sidebar-toggle">侧边栏</button><button id="mobile-new" aria-label="开启新对话"><svg width="18" height="18"><path d="M9.99994 1.22943C5 1 1 5 1 10"></path></svg></button><h1>有什么可以帮忙的？</h1><div id="messages"></div><textarea placeholder="给 DeepSeek 发送消息" aria-label="给 DeepSeek 发送消息"></textarea><button id="send">发送</button><button id="open-dialog">打开弹层</button><dialog><p>网页弹层</p><button id="close-dialog">关闭</button></dialog><input type="file" aria-label="上传附件"></main></section>
    <script>
    window.instanceId = crypto.randomUUID(); window.newCount = 0;
    window.thinkingMode = 'off'; window.thoughts = [];
    function thinkingReply(){
      const index=window.thoughts.length, record={clicks:0,expanded:window.thinkingMode!=='collapsed',done:false};
      window.thoughts.push(record);
      const row=document.createElement('div');row.dataset.virtualListItemKey=String(index);
      const message=document.createElement('div');message.className='ds-message';row.append(message);
      const answer=document.createElement('p');answer.className='ds-assistant-message-main-content';
      document.querySelector('#messages').append(row);
      const content=document.createElement('div');content.className='ds-think-content';content.textContent='思考片段 ';
      {
        const group=document.createElement('div');group.className='thinking-section';group.style.setProperty('--collapsible-area-title-height','34px');
        const header=document.createElement('div');header.className='thinking-title';
        const toggle=document.createElement('div');toggle.className='thinking-toggle';toggle.style.cursor='pointer';
        const title=document.createElement('span');title.textContent=record.done?'Thought for 2 seconds':'思考中…';
        toggle.append(title);toggle.insertAdjacentHTML('beforeend','<svg width="14" height="14"><path d="M2 5L7 10L12 5"/></svg>');
        header.append(toggle);group.append(header);
        if(record.expanded)group.append(content);
        toggle.onclick=()=>{record.clicks++;record.expanded=!record.expanded;if(record.expanded)group.append(content);else content.remove()};
        message.prepend(group);record.title=title;
      }
      message.append(answer);
      let i=0;const timer=setInterval(()=>{content.textContent+='思考片段 ';answer.textContent+='回答片段 ';if(++i===12){clearInterval(timer);record.done=true;record.title.textContent='Thought for 2 seconds';row.dataset.complete='true'}},100);
    }
    function render(){const logged=localStorage.getItem('logged')==='yes';document.querySelector('#login').hidden=logged;document.querySelector('#chat').hidden=!logged;}
    document.querySelector('#sign-in').onclick=()=>{localStorage.setItem('logged','yes');document.cookie='fixtureSession=active; Max-Age=86400; path=/';history.pushState({},'', '/');render()};
    document.querySelector('#logout').onclick=()=>{localStorage.removeItem('logged');history.pushState({},'', '/sign_in');render()};
    const newChat=()=>{window.newCount++;document.querySelector('textarea').value='';document.querySelector('#messages').textContent='';};document.querySelector('#new').onclick=newChat;document.querySelector('#mobile-new').onclick=newChat;
    document.querySelector('#sidebar-toggle').onclick=()=>{const a=document.querySelector('aside');a.hidden=!a.hidden;document.querySelector('#sidebar-toggle').setAttribute('aria-label',a.hidden?'展开侧边栏':'收起侧边栏')};
    document.querySelector('#send').onclick=()=>{if(window.thinkingMode!=='off'){thinkingReply();return}let i=0;const msg=document.createElement('p');document.querySelector('#messages').append(msg);const timer=setInterval(()=>{msg.textContent+='回答片段 ';if(++i===12)clearInterval(timer)},100)};
    document.querySelector('#open-dialog').onclick=()=>document.querySelector('dialog').showModal();document.querySelector('#close-dialog').onclick=()=>document.querySelector('dialog').close();render();
    </script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
