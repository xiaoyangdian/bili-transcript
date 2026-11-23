import json
import glob

p = glob.glob(r'D:\e\baidu\抖音评论回复抓包_2026-11-23-01-58-51*.json')[0]
d = json.load(open(p, encoding='utf-8'))
e = next(x for x in d if x.get('kind') == 'notice-list' and x.get('noticeGroup') == '960')
n = e['data']['notice_list_v2'][0]
print('=== 通知对象全部字段 ===')
print(json.dumps(n, ensure_ascii=False, indent=1)[:6000])
