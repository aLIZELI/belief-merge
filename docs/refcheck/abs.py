import sys, re, urllib.request, time

def get(url, tries=3):
    for i in range(tries):
        try:
            req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'})
            return urllib.request.urlopen(req, timeout=40).read().decode('utf-8','replace')
        except Exception as e:
            if i==tries-1: return 'ERR:'+str(e)
            time.sleep(2)

def meta(html):
    d={}
    for m in re.finditer(r'<meta\s+name="(citation_[^"]+)"\s+content="([^"]*)"', html):
        d.setdefault(m.group(1),[]).append(m.group(2))
    return d

for aid in sys.argv[1:]:
    html=get('https://arxiv.org/abs/'+aid)
    if html.startswith('ERR:'):
        print(aid, html); continue
    d=meta(html)
    print('ARXIV', aid)
    print('  title  :', (d.get('citation_title') or ['?'])[0])
    print('  authors:', '; '.join(d.get('citation_author') or []))
    print('  date   :', (d.get('citation_date') or ['?'])[0], '| online:', (d.get('citation_online_date') or ['?'])[0])
    print('  arxiv_id:', (d.get('citation_arxiv_id') or ['?'])[0])
    print('  doi    :', (d.get('citation_doi') or ['none'])[0])
    jr=(d.get('citation_journal_title') or [''])[0]
    print('  journal:', jr, '| vol', (d.get('citation_volume') or [''])[0])
    print()
    time.sleep(1.5)
