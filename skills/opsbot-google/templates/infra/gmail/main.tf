# The Gmail push: four objects. Gmail publishes a notification per mailbox change to the topic
# (through its own push service account); the bot's listener pulls them from the subscription
# with its own grant.

resource "google_pubsub_topic" "gmail" {
  project = var.project
  name    = var.topic
}

# Gmail's push service publishes as this fixed account (Gmail API push notifications guide).
resource "google_pubsub_topic_iam_member" "gmail_publisher" {
  project = var.project
  topic   = google_pubsub_topic.gmail.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
}

resource "google_pubsub_subscription" "gmail" {
  project = var.project
  name    = var.subscription
  topic   = google_pubsub_topic.gmail.id

  # A notification carries no content; one not acknowledged in time is redelivered, and a week
  # of them is kept while the listener is down.
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  expiration_policy {
    ttl = "" # never expires for inactivity
  }
}

resource "google_pubsub_subscription_iam_member" "gmail_subscriber" {
  project      = var.project
  subscription = google_pubsub_subscription.gmail.name
  role         = "roles/pubsub.subscriber"
  member       = var.subscriber
}
