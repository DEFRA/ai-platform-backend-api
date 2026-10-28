#!/bin/bash

# The GitOps messaging as CDP creates it (plan 5, 14), mirrored for local runs.
# CDP allows one owning service per queue, so each direction is a topic its
# producer owns and a queue its consumer owns, subscribed with raw delivery:
#
#   commands: backend topic aip_gitops_commands -> worker queue aip_gitops_commands_worker
#   events:   worker topic aip_gitops_events_worker -> backend queue aip_gitops_events
#             (the workflows also send straight to aip_gitops_events)
#
# Everything is FIFO with content-based deduplication off, because the
# commandId and the eventId are sent as the deduplication ID. Each queue has a
# dead-letter queue taking a message after 3 failed receives.

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

create_fifo_topic() {
  aws sns create-topic \
    --name "$1" \
    --attributes "FifoTopic=true,ContentBasedDeduplication=false" >/dev/null
}

# Raw delivery: the queue body is the message itself, as on CDP.
subscribe_raw() {
  local topic_name="$1"
  local queue_name="$2"

  aws sns subscribe \
    --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT_ID}:${topic_name}" \
    --protocol sqs \
    --notification-endpoint "arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${queue_name}" \
    --attributes RawMessageDelivery=true >/dev/null
}

create_fifo_topic aip_gitops_commands.fifo
create_fifo_queue_with_dead_letters aip_gitops_commands_worker.fifo
subscribe_raw aip_gitops_commands.fifo aip_gitops_commands_worker.fifo

create_fifo_topic aip_gitops_events_worker.fifo
create_fifo_queue_with_dead_letters aip_gitops_events.fifo
subscribe_raw aip_gitops_events_worker.fifo aip_gitops_events.fifo
