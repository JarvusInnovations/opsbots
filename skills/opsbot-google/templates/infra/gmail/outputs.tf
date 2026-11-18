output "topic" {
  description = "streams.gmail_push.topic"
  value       = google_pubsub_topic.gmail.name
}

output "subscription" {
  description = "streams.gmail_push.subscription"
  value       = google_pubsub_subscription.gmail.name
}
