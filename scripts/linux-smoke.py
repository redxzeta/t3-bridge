#!/usr/bin/env python3
"""Exercise emitted CLI code in disposable Linux state; never print captured credentials."""
import os,pty,subprocess,tempfile,pathlib,json,select,time,re,socket,urllib.request,urllib.error,shutil
if os.uname().sysname != 'Linux':
    raise SystemExit('Linux-only smoke check; macOS and WSL2 verification must be recorded separately')
repo=pathlib.Path(__file__).resolve().parents[1]
node=shutil.which('node')
root=pathlib.Path(tempfile.mkdtemp(prefix='t3-bridge-linux-smoke-'))
processes=[]
smoke_env={k:v for k,v in os.environ.items() if k not in ["BETTER_AUTH_SECRET","T3_BRIDGE_CONFIG","T3_BRIDGE_STATE_DIR"]}
def terminal(args, answer=None):
    master,slave=pty.openpty()
    p=subprocess.Popen([node,'--env-file-if-exists=.env',str(repo/'dist/main.js'),*args],cwd=root,stdin=slave,stdout=slave,stderr=slave,env=smoke_env)
    processes.append(p)
    os.close(slave); output=b''; deadline=time.monotonic()+20; answered=False
    while time.monotonic()<deadline:
        ready,_,_=select.select([master],[],[],.1)
        if ready:
            try: data=os.read(master,65536)
            except OSError: break
            if not data: break
            output+=data
            if answer and b'(hidden):' in output and not answered:
                os.write(master,answer.encode()+b'\n');answered=True
        if p.poll() is not None and not ready: break
    # PTY EOF can arrive before the child has finished exiting.
    try: p.wait(timeout=max(0,deadline-time.monotonic()))
    except subprocess.TimeoutExpired:
        p.kill();p.wait();raise AssertionError('Terminal command timed out')
    finally: os.close(master)
    return p.returncode,output.decode()
def request(port,path,body=None):
    headers={'content-type':'application/json','origin':'https://bridge.example.com'}
    req=urllib.request.Request(f'http://127.0.0.1:{port}{path}',data=json.dumps(body).encode() if body is not None else None,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=3) as response: return response.status,response.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
def start(port):
    p=subprocess.Popen([node,'--env-file=.env',str(repo/'dist/main.js'),'start'],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=smoke_env)
    processes.append(p)
    for _ in range(100):
        assert p.poll() is None,'Bridge exited before listening'
        try:
            if request(port,'/sign-in')[0]==200:return p
        except (OSError,urllib.error.URLError):pass
        time.sleep(.05)
    raise AssertionError('Bridge failed to listen')
try:
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    (root/'config.json').write_text(json.dumps({'publicUrl':'https://bridge.example.com','listenPort':port,'ownerEmail':'owner@example.com','upstreams':[{'name':'home','url':'http://127.0.0.1:3773/mcp'}]}))
    code,output=terminal(['setup']);assert code==0
    password=re.search(r'shown once\): ([A-Za-z0-9_-]{128})',output).group(1)
    original=(root/'.env').read_bytes()
    assert (root/'.env').stat().st_mode&0o777==0o600
    assert (root/'state').stat().st_mode&0o777==0o700
    assert (root/'state/gateway.sqlite').stat().st_mode&0o777==0o600
    p=start(port)
    assert request(port,'/api/auth/sign-in/email',{'email':'owner@example.com','password':password})[0]==200
    assert request(port,'/mcp',{})[0]==401
    assert request(port,'/api/auth/sign-up/email',{'name':'Other','email':'other@example.com','password':password})[0]>=400
    p.terminate();p.wait(timeout=10)
    p=start(port)
    assert request(port,'/api/auth/sign-in/email',{'email':'owner@example.com','password':password})[0]==200
    code,output=terminal(['setup']);assert code==1 and 'Signing material already exists' in output
    assert password not in output and (root/'.env').read_bytes()==original
    code,output=terminal(['rotate-password'],password);assert code==0
    assert password not in output,'Current password echoed by prompt'
    replacement=re.search(r'shown once\): ([A-Za-z0-9_-]{128})',output).group(1)
    assert request(port,'/api/auth/sign-in/email',{'email':'owner@example.com','password':replacement})[0]==200
    assert request(port,'/api/auth/sign-in/email',{'email':'owner@example.com','password':password})[0]>=400
    assert (root/'.env').read_bytes()==original
    print('PASS Linux terminal setup, private permissions, start, owner login, MCP 401, signup refusal, stop/restart, repeat-setup refusal, hidden password rotation, old-password rejection')
finally:
    for p in processes:
        if p.poll() is None:p.terminate();p.wait(timeout=10)
    shutil.rmtree(root)
