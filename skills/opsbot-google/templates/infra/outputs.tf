output "gmail_topic" {
  description = "streams.gmail_push.topic"
  value       = google_pubsub_topic.gmail.name
}

output "gmail_subscription" {
  description = "streams.gmail_push.subscription"
  value       = google_pubsub_subscription.gmail.name
}
