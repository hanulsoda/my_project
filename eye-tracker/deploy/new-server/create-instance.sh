#!/usr/bin/env bash
# Run in OCI Cloud Shell. Creates a small second VM (dahim-reading-a1) in the same subnet as the
# existing server, with your NEW ssh public key and the first-boot setup from cloud-init.yaml.
# Usage:  INST=<existing instance ocid> PUBKEY='ssh-ed25519 AAAA... name' ./create-instance.sh
set -e
: "${INST:?set INST to the existing server's instance OCID}"
: "${PUBKEY:?set PUBKEY to your ssh public key line}"
BRANCH="${BRANCH:-ccr-d047b660-c42kqg}"
curl -fsSL "https://raw.githubusercontent.com/hanulsoda/my_project/$BRANCH/eye-tracker/deploy/new-server/cloud-init.yaml" -o "$HOME/cloud-init.yaml"
printf '%s\n' "$PUBKEY" > "$HOME/new_key.pub"
G() { oci compute instance get --instance-id "$INST" --query "$1" --raw-output; }
COMP="$(G 'data."compartment-id"')"
AD="$(G 'data."availability-domain"')"
SUBNET="$(oci compute vnic-attachment list --compartment-id "$COMP" --instance-id "$INST" --query 'data[0]."subnet-id"' --raw-output)"
# Newest Canonical Ubuntu 24.04 image that runs on the A1 (ARM) shape.
IMG="$(oci compute image list --compartment-id "$COMP" --operating-system 'Canonical Ubuntu' --operating-system-version '24.04' \
  --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)"
echo "compartment=$COMP"; echo "AD=$AD"; echo "image=$IMG"; echo "subnet=$SUBNET"
for v in COMP AD SUBNET IMG; do eval "[ -n \"\${$v:-}\" ]" || { echo "ERROR: $v is empty"; exit 1; }; done
NEW="$(oci compute instance launch --compartment-id "$COMP" --availability-domain "$AD" \
  --display-name dahim-reading-a1 --shape VM.Standard.A1.Flex --shape-config '{"ocpus":1,"memoryInGBs":6}' \
  --image-id "$IMG" --subnet-id "$SUBNET" --assign-public-ip true --boot-volume-size-in-gbs 50 \
  --ssh-authorized-keys-file "$HOME/new_key.pub" --user-data-file "$HOME/cloud-init.yaml" \
  --wait-for-state RUNNING --query 'data.id' --raw-output)"
echo "new instance: $NEW"
IP="$(oci compute instance list-vnics --instance-id "$NEW" --query 'data[0]."public-ip"' --raw-output)"
echo "NEW_SERVER_IP=$IP"
