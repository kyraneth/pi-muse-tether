import sys,json
for line in sys.stdin:
 f=json.loads(line);method=f.get('method');result=None
 if method=='initialize':result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'synthetic_pi','version':'1'}}
 elif method=='tools/list':result={'tools':[{'name':n,'description':'Synthetic offline '+n+' fixture; does not execute.','inputSchema':{'type':'object','properties':{}}} for n in sys.argv[1:]]}
 elif method=='tools/call':raise RuntimeError('Offline fixture must never execute tools')
 elif 'id' in f:result={}
 if result is not None:print(json.dumps({'jsonrpc':'2.0','id':f['id'],'result':result}),flush=True)
