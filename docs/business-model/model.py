#!/usr/bin/env python3
"""BountyCam five-year business model (pitch deck slide 14).

Bottom-up and deliberately simple: every input below is an assumption, not data. Scout
payouts (GMV) pass through to Scouts and are not revenue. Revenue is the platform fee,
campaign subscriptions, verification API calls and data products.

Run:  python3 docs/business-model/model.py               bold case
      python3 docs/business-model/model.py conservative  about a quarter of the volume
"""
import sys

YEARS = [2027, 2028, 2029, 2030, 2031]

BOLD = dict(
    biz_customers_end=[40, 300, 1200, 3500, 8000],     # business requesters at year end
    checks_per_biz_month=[150, 250, 400, 500, 600],
    consumer_checks=[10e3, 120e3, 700e3, 3e6, 9e6],    # one-off checks per year
    avg_reward=[10, 11, 12, 12, 12],                    # USD per check, paid to the Scout
    take_rate=[0.15, 0.15, 0.15, 0.14, 0.13],          # fee on top of the reward
    sub_per_biz_month=[300, 500, 700, 900, 1000],       # campaign subscription, USD
    api_calls=[0, 2e6, 25e6, 150e6, 600e6],             # apps, insurers, AI agents
    api_price=[0, 0.25, 0.20, 0.15, 0.10],              # USD per call
    data_revenue=[0, 0.2e6, 3e6, 18e6, 55e6],           # sensor and condition data, datasets
    headcount=[8, 30, 90, 200, 350],
    cost_per_head=[150e3, 150e3, 150e3, 160e3, 170e3],
    sales_marketing=[0.5e6, 3e6, 10e6, 25e6, 45e6],     # incl. Scout acquisition
    checks_per_active_scout_month=[20, 25, 30, 35, 40],
)
CONSERVATIVE = dict(BOLD,
    biz_customers_end=[30, 150, 450, 1100, 2400],
    checks_per_biz_month=[120, 200, 300, 350, 400],
    consumer_checks=[5e3, 40e3, 200e3, 800e3, 2.5e6],
    api_calls=[0, 0.5e6, 6e6, 35e6, 140e6],
    data_revenue=[0, 0.1e6, 0.8e6, 4e6, 12e6],
    headcount=[8, 22, 50, 90, 150],
    sales_marketing=[0.4e6, 2e6, 5e6, 10e6, 16e6],
)
# Cost of revenue as a share of each stream: storage, compute, chain fees, payments, support.
COST_SHARE = dict(fee=0.22, subs=0.12, api=0.15, data=0.25)
# Compliance and licensing (KYC, payments rules), fraud and dispute losses, and paying users'
# network fees, as a share of Scout payouts. Kept out of gross margin, inside EBITDA.
RISK_AND_COMPLIANCE = 0.02


def run(a):
    rows, cum, low = [], 0.0, 0.0
    for i, year in enumerate(YEARS):
        prev = a['biz_customers_end'][i - 1] if i else 0
        customers = (prev + a['biz_customers_end'][i]) / 2          # average over the year
        checks = customers * a['checks_per_biz_month'][i] * 12 + a['consumer_checks'][i]
        gmv = checks * a['avg_reward'][i]
        s = dict(fee=gmv * a['take_rate'][i],
                 subs=customers * a['sub_per_biz_month'][i] * 12,
                 api=a['api_calls'][i] * a['api_price'][i],
                 data=a['data_revenue'][i])
        revenue = sum(s.values())
        gross = revenue - sum(s[k] * COST_SHARE[k] for k in s)
        risk = gmv * RISK_AND_COMPLIANCE
        ebitda = (gross - a['headcount'][i] * a['cost_per_head'][i] - a['sales_marketing'][i]
                  - risk)
        cum += ebitda
        low = min(low, cum)
        scouts = checks / 12 / a['checks_per_active_scout_month'][i]
        rows.append(dict(year=year, customers=a['biz_customers_end'][i], checks=checks, gmv=gmv,
                         revenue=revenue, gross_margin=gross / revenue, ebitda=ebitda,
                         cumulative=cum, scouts=scouts, scout_year=gmv / scouts, risk=risk, **s))
    return rows, -low


def main():
    case = 'conservative' if 'conservative' in sys.argv[1:] else 'bold'
    rows, peak_burn = run(CONSERVATIVE if case == 'conservative' else BOLD)
    m = lambda x: '%8.2f' % (x / 1e6)
    print('%s case, USD millions unless stated' % case.capitalize())
    print('year  customers  checks(M)  to Scouts  fee  subs  api  data  revenue  GM  risk  EBITDA  cum.  active Scouts  $/Scout/yr')
    for r in rows:
        print('%d %9d %10.2f %s %s %s %s %s %s %3.0f%% %s %s %s %10.0f %8.0f' % (
            r['year'], r['customers'], r['checks'] / 1e6, m(r['gmv']), m(r['fee']), m(r['subs']),
            m(r['api']), m(r['data']), m(r['revenue']), 100 * r['gross_margin'], m(r['risk']),
            m(r['ebitda']), m(r['cumulative']), r['scouts'], r['scout_year']))
    last = rows[-1]
    print('Peak cumulative burn: %.1f' % (peak_burn / 1e6))
    print('%d mix: fee %.0f%%, subscriptions %.0f%%, API %.0f%%, data %.0f%%; EBITDA margin %.0f%%' % (
        last['year'], *(100 * last[k] / last['revenue'] for k in ('fee', 'subs', 'api', 'data')),
        100 * last['ebitda'] / last['revenue']))


if __name__ == '__main__':
    main()
