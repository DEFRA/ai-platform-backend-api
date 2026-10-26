#!/bin/bash

# The GitOps command and event queues the backend and the GitOps worker share
# (plan 5, 14). Both are FIFO with content-based deduplication off, because
# the commandId and the eventId are sent as the deduplication ID. Each has a
# dead-letter queue taking a message after 3 failed receives. CDP creates the
# same four queues; this mirrors them for local runs with TENANT_ORCHESTRATOR=sqs.

ACCOUNT_ID=000000000000
REGION="${AWS_DEFAULT_REGION:-eu-west-2}"
VISIBILITY_TIMEOUT_SECONDS=60
MAX_RECEIVE_COUNT=3

create_fifo_queue() {
  local name="$1"
  local attributes="$2"

  aws sqs create-queue \
    --queue-name "$name" \
    --attributes "$attributes" >/dev/null
}

create_fifo_queue_with_dead_letters() {
  local name="$1"
  local dead_letter_name="${name%.fifo}-deadletter.fifo"
  local dead_letter_arn="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${dead_letter_name}"
  local redrive_policy="{\\\"deadLetterTargetArn\\\":\\\"${dead_letter_arn}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}"

  create_fifo_queue "$dead_letter_name" \
    "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\"}"
  create_fifo_queue "$name" \
    "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"${VISIBILITY_TIMEOUT_SECONDS}\",\"RedrivePolicy\":\"${redrive_policy}\"}"
}

create_fifo_queue_with_dead_letters aip-gitops-commands.fifo
create_fifo_queue_with_dead_letters aip-gitops-events.fifo
