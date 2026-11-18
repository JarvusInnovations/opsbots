output "topic" {
  description = "streams.meet_push.topic"
  value       = google_pubsub_topic.meet.name
}

output "subscription" {
  description = "streams.meet_push.subscription"
  value       = google_pubsub_subscription.meet.name
}
