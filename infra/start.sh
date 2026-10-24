#!/usr/bin/env bash
# Start an already-created Moonshift GPU instance and record the start time.
# This script intentionally never creates instances, security groups, or keys.
set -euo pipefail

: "${MS_INSTANCE_ID:?Set MS_INSTANCE_ID to the pre-created g4dn.xlarge instance ID}"
AWS_REGION="${AWS_REGION:-us-east-2}"
AWS_PROFILE="${AWS_PROFILE:-}"

aws_args=(--region "$AWS_REGION")
if [[ -n "$AWS_PROFILE" ]]; then
  aws_args+=(--profile "$AWS_PROFILE")
fi

state="$(aws "${aws_args[@]}" ec2 describe-instances --instance-ids "$MS_INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name' --output text)"
if [[ "$state" == "stopped" ]]; then
  aws "${aws_args[@]}" ec2 start-instances --instance-ids "$MS_INSTANCE_ID" >/dev/null
fi
aws "${aws_args[@]}" ec2 wait instance-running --instance-ids "$MS_INSTANCE_ID"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$script_dir/.state"
printf '%s,start,%s,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MS_INSTANCE_ID" "$AWS_REGION" >> "$script_dir/.state/hours.csv"

aws "${aws_args[@]}" ec2 describe-instances --instance-ids "$MS_INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].{State:State.Name,PrivateIp:PrivateIpAddress,PublicIp:PublicIpAddress}' \
  --output table
