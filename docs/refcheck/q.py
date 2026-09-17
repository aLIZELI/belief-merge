import sys, json, urllib.parse, urllib.request, time, re

def get(url, tries=4, sleep0=2.0):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'refcheck/1.0 (mailto:refcheck@example.org)','Accept':'application/json, text/xml, */*'})
            return urllib.request.urlopen(req, timeout=40).read().decode('utf-8','replace')
        except Exception as e:
            if i==tries-1: return 'ERR:'+str(e)
            time.sleep(sleep0*(i+1))

def crossref(q, rows=3):
    u='https://api.crossref.org/works?rows=%d&select=title,author,container-title,issued,DOI,type,page,volume&query.bibliographic=%s'%(rows,urllib.parse.quote(q))
    raw=get(u)
    if raw.startswith('ERR:'): return [raw]
    try: items=json.loads(raw)['message']['items']
    except Exception as e: return ['PARSEERR '+str(e)]
    out=[]
    for it in items:
        out.append({'title':(it.get('title') or ['?'])[0],
          'authors':'; '.join((a.get('family','')+' '+a.get('given','')).strip() for a in (it.get('author') or [])[:8]),
          'venue':(it.get('container-title') or ['?'])[0] if it.get('container-title') else '?',
          'year':(it.get('issued',{}).get('date-parts') or [[None]])[0][0],
          'doi':it.get('DOI'),'vol':it.get('volume'),'page':it.get('page'),'type':it.get('type')})
    return out

def openalex(q, rows=4):
    u='https://api.openalex.org/works?per-page=%d&search=%s'%(rows,urllib.parse.quote(q))
    raw=get(u)
    if raw.startswith('ERR:'): return [raw]
    try: items=json.loads(raw)['results']
    except Exception as e: return ['PARSEERR '+str(e)]
    out=[]
    for it in items:
        src=((it.get('primary_location') or {}).get('source') or {})
        out.append({'title':it.get('title'),
          'authors':'; '.join(a['author']['display_name'] for a in (it.get('authorships') or [])[:8]),
          'venue':src.get('display_name'),'year':it.get('publication_year'),
          'doi':(it.get('doi') or '').replace('https://doi.org/',''),
          'type':it.get('type'),'oa_id':it.get('id')})
    return out

def arxiv(q, rows=4):
    u='https://export.arxiv.org/api/query?max_results=%d&search_query=%s'%(rows,urllib.parse.quote(q))
    raw=get(u)
    if raw.startswith('ERR:'): return [raw]
    out=[]
    for e in re.findall(r'<entry>(.*?)</entry>', raw, re.S):
        def g(t):
            m=re.search(r'<%s[^>]*>(.*?)</%s>'%(t,t), e, re.S)
            return re.sub(r'\s+',' ',m.group(1)).strip() if m else ''
        out.append({'title':g('title'),'id':g('id'),'published':g('published'),
          'updated':g('updated'),'authors':'; '.join(re.findall(r'<name>(.*?)</name>',e)),
          'summary':g('summary')[:220]})
    return out

def openalex_raw(u):
    raw=get(u)
    if raw.startswith('ERR:'): return [raw]
    try: items=json.loads(raw)['results']
    except Exception as e: return ['PARSEERR '+str(e)]
    out=[]
    for it in items:
        src=((it.get('primary_location') or {}).get('source') or {})
        out.append({'title':it.get('title'),
          'authors':'; '.join(a['author']['display_name'] for a in (it.get('authorships') or [])[:8]),
          'venue':src.get('display_name'),'year':it.get('publication_year'),
          'doi':(it.get('doi') or '').replace('https://doi.org/',''),
          'type':it.get('type'),'oa_id':it.get('id')})
    return out

if __name__=='__main__':
    mode=sys.argv[1]
    for line in sys.stdin:
        line=line.strip()
        if not line: continue
        label,q = line.split('\t',1) if '\t' in line else (line,line)
        print('### '+label+' :: '+q)
        if mode=='oat':
            raw=openalex_raw('https://api.openalex.org/works?per-page=5&filter=title.search:'+urllib.parse.quote(q))
            fn=lambda _q: raw
        else:
            fn={'cr':crossref,'oa':openalex,'ax':arxiv}[mode]
        for r in fn(q):
            print('   ', r if isinstance(r,str) else json.dumps(r,ensure_ascii=False))
        print()
        time.sleep(0.4)
