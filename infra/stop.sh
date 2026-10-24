#!/usr/bin/env bash
# Stop the Moonshift GPU instance when it is not actively being used.
set -euo pipefail

: "${MS_INSTANCE_ID:?Set MS_INSTANCE_ID to the pre-created g4dn.xlarge instance ID}"
AWS_REGION="${AWS_REGION:-us-east-2}"
AWS_PROFILE="${AWS_PROFILE:-}"

aws_args=(--region "$AWS_REGION")
if [[ -n "$AWS_PROFILE" ]]; then
  aws_args+=(--profile "$AWS_PROFILE")
fi

state="$(aws "${aws_args[@]}" ec2 describe-instances --instance-ids "$MS_INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name' --output text)"
if [[ "$state" == "running" ]]; then
  aws "${aws_args[@]}" ec2 stop-instances --instance-ids "$MS_INSTANCE_ID" >/dev/null
  aws "${aws_args[@]}" ec2 wait instance-stopped --instance-ids "$MS_INSTANCE_ID"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$script_dir/.state"
printf '%s,stop,%s,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MS_INSTANCE_ID" "$AWS_REGION" >> "$script_dir/.state/hours.csv"
echo "Instance $MS_INSTANCE_ID is stopped."
