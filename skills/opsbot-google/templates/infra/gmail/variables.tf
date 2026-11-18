# Every name and id is required: nothing here defaults to a project, an address or a name.

variable "project" {
  description = "The Google Cloud project that holds the Pub/Sub objects (its id)."
  type        = string
}

variable "topic" {
  description = "The Pub/Sub topic Gmail publishes to (a short name, not a path); streams.gmail_push.topic."
  type        = string
}

variable "subscription" {
  description = "The pull subscription the listener reads (a short name); streams.gmail_push.subscription."
  type        = string
}

variable "subscriber" {
  description = "Who may pull: the IAM member for streams.gmail_push.account, e.g. \"user:<the bot's address>\"."
  type        = string
}
