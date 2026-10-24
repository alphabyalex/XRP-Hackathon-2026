#!/usr/bin/env bash
# Parameterized launch script for Moonshift AWS GPU worker.
# Creates security group and provisions one g4dn.xlarge EC2 instance in us-east-2.
#
# IMPORTANT: Do not run this script until human approval is confirmed in chat.
# Running instance costs against the $100 hackathon credit.
set -euo pipefail

if ! command -v aws >/dev/null 2>&1 && [[ -x "$(dirname "${BASH_SOURCE[0]}")/../.venv/bin/aws" ]]; then
  export PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.venv/bin:$PATH"
fi

AWS_REGION="${AWS_REGION:-us-east-2}"
AWS_PROFILE="${AWS_PROFILE:-}"
INSTANCE_TYPE="${INSTANCE_TYPE:-g4dn.xlarge}"
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-100}"
VOLUME_TYPE="${VOLUME_TYPE:-gp3}"
SG_NAME="${SG_NAME:-moonshift-gpu-sg}"
KEY_NAME="${KEY_NAME:-moonshift-gpu-key}"
ALLOWED_SSH_CIDR="${ALLOWED_SSH_CIDR:-}"
ALLOWED_API_CIDR="${ALLOWED_API_CIDR:-}"

aws_args=(--region "$AWS_REGION")
if [[ -n "$AWS_PROFILE" ]]; then
  aws_args+=(--profile "$AWS_PROFILE")
fi

echo "=== Moonshift AWS GPU Launch Configuration ==="
echo "Region:        $AWS_REGION"
echo "Instance type: $INSTANCE_TYPE (1x NVIDIA T4 16GB GPU)"
echo "Storage:       ${VOLUME_SIZE_GB} GB ($VOLUME_TYPE)"
echo "Security Grp:  $SG_NAME"

# 1. Verify AWS CLI connectivity
if ! aws "${aws_args[@]}" sts get-caller-identity >/dev/null 2>&1; then
  echo "Error: AWS CLI is not authenticated or profile is invalid. Please run 'aws configure'." >&2
  exit 1
fi

# 2. Check or create dedicated Security Group
VPC_ID="$(aws "${aws_args[@]}" ec2 describe-vpcs --filter "Name=is-default,Values=true" --query "Vpcs[0].VpcId" --output text)"
SG_ID="$(aws "${aws_args[@]}" ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || true)"

if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
  echo "Creating security group $SG_NAME in VPC $VPC_ID..."
  SG_ID="$(aws "${aws_args[@]}" ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "Moonshift GPU security group (SSH restricted, Compute on 5000, vLLM private)" \
    --vpc-id "$VPC_ID" \
    --query "GroupId" \
    --output text)"

  # Allow SSH from specified team CIDR if provided
  if [[ -n "$ALLOWED_SSH_CIDR" ]]; then
    echo "Authorizing SSH from $ALLOWED_SSH_CIDR..."
    aws "${aws_args[@]}" ec2 authorize-security-group-ingress \
      --group-id "$SG_ID" \
      --protocol tcp \
      --port 22 \
      --cidr "$ALLOWED_SSH_CIDR" >/dev/null
  fi

  # Allow Compute Router port 5000 only from specified API CIDR
  if [[ -n "$ALLOWED_API_CIDR" ]]; then
    echo "Authorizing Compute port 5000 from $ALLOWED_API_CIDR..."
    aws "${aws_args[@]}" ec2 authorize-security-group-ingress \
      --group-id "$SG_ID" \
      --protocol tcp \
      --port 5000 \
      --cidr "$ALLOWED_API_CIDR" >/dev/null
  fi
  # Note: Port 8000 (vLLM) is intentionally NEVER added to the security group.
else
  echo "Using existing security group: $SG_ID ($SG_NAME)"
fi

# 3. Resolve Deep Learning AMI (Ubuntu 22.04 with NVIDIA drivers)
echo "Querying Deep Learning AMI in $AWS_REGION..."
AMI_ID="${AMI_ID:-}"
if [[ -z "$AMI_ID" ]]; then
  AMI_ID="$(aws "${aws_args[@]}" ec2 describe-images \
    --owners amazon \
    --filters "Name=name,Values=Deep Learning OSS Nvidia Driver AMI GPU PyTorch * (Ubuntu 22.04)*" \
              "Name=state,Values=available" \
    --query "reverse(sort_by(Images, &CreationDate))[0].ImageId" \
    --output text)"
fi
echo "Resolved AMI: $AMI_ID"

# 4. Prepare block device mapping (100 GB gp3 root volume)
BLOCK_MAPPING="[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$VOLUME_SIZE_GB,\"VolumeType\":\"$VOLUME_TYPE\",\"DeleteOnTermination\":true}}]"

# 5. Launch instance
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_DATA_FILE="$SCRIPT_DIR/user-data.sh"

echo "Launching instance..."
INSTANCE_ID="$(aws "${aws_args[@]}" ec2 run-instances \
  --image-id "$AMI_ID" \
  --count 1 \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --block-device-mappings "$BLOCK_MAPPING" \
  --user-data "file://$USER_DATA_FILE" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=moonshift-gpu-a},{Key=Project,Value=Moonshift}]" \
  --query "Instances[0].InstanceId" \
  --output text)"

echo "Instance launched: $INSTANCE_ID"
echo "Waiting for instance to enter running state..."
aws "${aws_args[@]}" ec2 wait instance-running --instance-ids "$INSTANCE_ID"

PRIVATE_IP="$(aws "${aws_args[@]}" ec2 describe-instances --instance-ids "$INSTANCE_ID" --query "Reservations[0].Instances[0].PrivateIpAddress" --output text)"
PUBLIC_IP="$(aws "${aws_args[@]}" ec2 describe-instances --instance-ids "$INSTANCE_ID" --query "Reservations[0].Instances[0].PublicIpAddress" --output text)"

echo "=== Instance Details ==="
echo "Instance ID: $INSTANCE_ID"
echo "Private IP:  $PRIVATE_IP"
echo "Public IP:   $PUBLIC_IP"
echo ""
echo "Export these to manage the worker:"
echo "export MS_INSTANCE_ID=$INSTANCE_ID"
echo "export AWS_REGION=$AWS_REGION"
