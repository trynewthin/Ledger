import tempfile, pathlib, subprocess, os, json, urllib.request, http.cookiejar, shutil
root=pathlib.Path(__file__).resolve().parents[1]
qa=pathlib.Path(tempfile.mkdtemp(prefix='ledger-docker-qa-'))
for name in ['compose.yaml','backup.sh','restore.sh']:
 shutil.copy2(root/'deploy'/name,qa/name)
(qa/'secrets').mkdir()
(qa/'secrets'/'admin_password').write_text('docker-test-password-1234')
(qa/'secrets'/'admin_password').chmod(0o444)
image=os.environ.get('LEDGER_TEST_IMAGE','ledger:local')
(qa/'.env').write_text(f'LEDGER_IMAGE={image}\nLEDGER_ORIGIN=http://127.0.0.1:18088\nLEDGER_ADMIN_USER=docker-test\nLEDGER_PORT=18088\n')
# On BSD development hosts, preserve the inherited FD lock. Linux CI uses flock.
(qa/'bin').mkdir()
(qa/'bin'/'flock').write_text('#!/usr/bin/env python3\nimport fcntl,sys\nfcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX|fcntl.LOCK_NB)\n')
(qa/'bin'/'flock').chmod(0o755)
env={**os.environ,'COMPOSE_PROJECT_NAME':'ledger-qa-'+qa.name[-8:].replace('_','x'),'PATH':os.environ['PATH'] if shutil.which('flock') else str(qa/'bin')+':'+os.environ['PATH']}
def run(*args):
 result=subprocess.run(args,cwd=qa,env=env,text=True,capture_output=True)
 if result.returncode: print(result.stdout, result.stderr,flush=True)
 result.check_returncode()
 return result.stdout
cookies=http.cookiejar.CookieJar();client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
def post(path,data):
 req=urllib.request.Request('http://127.0.0.1:18088/api/'+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','X-Ledger-Request':'1'})
 return json.load(client.open(req))
try:
 print(run('docker','compose','up','-d','--wait','--wait-timeout','90'),flush=True)
 post('login',{'username':'docker-test','password':'docker-test-password-1234'})
 cats=post('action/categories_list',{})
 post('action/entries_add',{'request_id':'docker-smoke-one','entry':{'amount':'8.88','category_id':cats[0]['id']}})
 print(run('./backup.sh'),flush=True)
 backup=sorted((qa/'backups').glob('*.db'))[0]
 post('action/entries_add',{'request_id':'docker-smoke-two','entry':{'amount':'1.11','category_id':cats[0]['id']}})
 assert post('action/report',{})['expense']==999
 print(run('./restore.sh',str(backup)),flush=True)
 assert post('action/report',{})['expense']==888
 print(run('docker','compose','restart','ledger'),flush=True)
 print(run('docker','compose','up','-d','--wait','--wait-timeout','90'),flush=True)
 assert post('action/report',{})['expense']==888
 print('PASS: container health, login, accounting, consistent backup, restore, restart persistence',flush=True)
finally:
 print(run('docker','compose','down','-v'),flush=True)
 print('QA artifacts: '+str(qa),flush=True)
