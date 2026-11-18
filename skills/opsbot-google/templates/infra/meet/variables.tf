# Every name and id is required: nothing here defaults to a project, an address or a name.

variable "project" {
  description = "The Google Cloud project that holds the Pub/Sub objects (its id). The Workspace Events API wants the topic in the project of the OAuth client the listener signs in with."
  type        = string
}

variable "topic" {
  description = "The Pub/Sub topic Meet events are delivered to (a short name, not a path); streams.meet_push.topic."
  type        = string
}

variable "subscription" {
  description = "The pull subscription the listener reads (a short name); streams.meet_push.subscription."
  type        = string
}

variable "subscriber" {
  description = "Who may pull: the IAM member for streams.meet_push.account, e.g. \"user:<the bot's address>\"."
  type        = string
}
