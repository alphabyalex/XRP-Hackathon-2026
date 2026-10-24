# Pricing data sources

All prices retrieved 2026-10-24. AWS EC2 on-demand, Linux. Figures come from the default view of the Vantage
instance pages, which is us-east-1 Linux, but the pages do not label the region explicitly. Cross-check on the
AWS pricing calculator before quoting them to judges.

| GPU | Instance | Instance $/hr | GPUs | $/GPU-hr | Source |
|---|---|---|---|---|---|
| T4 | g4dn.xlarge | 0.526 | 1 | 0.526 | https://instances.vantage.sh/aws/ec2/g4dn.xlarge |
| A10G | g5.xlarge | 1.006 | 1 | 1.006 | https://instances.vantage.sh/aws/ec2/g5.xlarge |
| L4 | g6.xlarge | 0.8048 | 1 | 0.8048 | https://instances.vantage.sh/aws/ec2/g6.xlarge |
| A100 | p4d.24xlarge | 21.957642 | 8 | 2.7447 | https://instances.vantage.sh/aws/ec2/p4d.24xlarge |
| H100 | p5.48xlarge | 55.04 | 8 | 6.88 | https://instances.vantage.sh/aws/ec2/p5.48xlarge |
| H200 | p5en.48xlarge | 63.296 | 8 | 7.912 | https://instances.vantage.sh/aws/ec2/p5en.48xlarge |
| B200 | p6-b200.48xlarge | 113.9328 | 8 | 14.2416 | https://instances.vantage.sh/aws/ec2/p6-b200.48xlarge |

The brief's T4 figure ($0.526/hr, Holori calculator) matches.

Only the T4 price drives our product prices (both demo GPUs are g4dn.xlarge). The others are context for the UI.

## Placeholders (not sourced, labeled in config.py)
- Throughput: 40 tokens/s on the T4. Waiting on Kristian's measured number. Use aggregate batched vLLM
  throughput, not single-stream speed, or inference prices will come out far too high.
- Power cost: $0.0105/hr (T4 is 70W, times $0.15/kWh).
- Useful life 36 months, discount rate 15%, inference margin 50%, booked fraction 20%.

## Not done yet
- Kalshi GPU rental forward curves (B200, H200, A100): series tickers not yet found. Optional, UI only.
