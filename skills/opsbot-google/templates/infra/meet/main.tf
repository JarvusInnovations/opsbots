# The Meet push: four objects. A Workspace Events subscription (made by `opsbot-google ensure`,
# not here) delivers each transcript event to the topic through Meet's own push service account;
# the bot's listener pulls them from the subscription with its own grant.

resource "google_pubsub_topic" "meet" {
  project = var.project
  name    = var.topic
}

# Meet's event push service publishes as this fixed account (Workspace Events API, "Create a
# Google Workspace subscription": https://developers.google.com/workspace/events/guides/create-subscription).
resource "google_pubsub_topic_iam_member" "meet_publisher" {
  project = var.project
  topic   = google_pubsub_topic.meet.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:meet-api-event-push@system.gserviceaccount.com"
}

resource "google_pubsub_subscription" "meet" {
  project = var.project
  name    = var.subscription
  topic   = google_pubsub_topic.meet.id

  # An event carries a resource name, never content; one not acknowledged in time is
  # redelivered, and a week of them is kept while the listener is down.
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  expiration_policy {
    ttl = "" # never expires for inactivity
  }
}

resource "google_pubsub_subscription_iam_member" "meet_subscriber" {
  project      = var.project
  subscription = google_pubsub_subscription.meet.name
  role         = "roles/pubsub.subscriber"
  member       = var.subscriber
}
