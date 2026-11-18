# opsbot-google: the cloud objects

Two OpenTofu (or Terraform) modules, one per source, for the Pub/Sub objects each push needs.
Call only the one for the source the bot uses, or both. Neither has a backend, provider
settings, a project or state: call it from your own root module, which owns those.

```hcl
module "bot_gmail_push" {
  source = "./path/to/opsbot-google/templates/infra/gmail" # a copy in your infra repo

  project      = "<your project id>"
  topic        = "<topic name>"
  subscription = "<subscription name>"
  subscriber   = "user:<the bot's Google address>"
}

module "bot_meet_push" {
  source = "./path/to/opsbot-google/templates/infra/meet"

  project      = "<the OAuth client's project id>"
  topic        = "<topic name>"
  subscription = "<subscription name>"
  subscriber   = "user:<the bot's Google address>"
}
```

Every input of a module is required; a source you do not use is a module you do not call. The
outputs are the two names to put in `streams.gmail_push` or `streams.meet_push` (`topic`,
`subscription`), with `project` and `account` beside them.

Requires the `hashicorp/google` provider 8.x and the Pub/Sub API enabled in the project
(`pubsub.googleapis.com`). In the project that owns the OAuth client: the Gmail API
(`gmail.googleapis.com`) for Gmail; the Google Meet REST API (`meet.googleapis.com`) and the
Google Workspace Events API (`workspaceevents.googleapis.com`) for Meet.

## Gmail, by hand

1. A **topic**, e.g. `gcloud pubsub topics create <topic> --project <project>`.
2. **Gmail's publisher grant** on it: `roles/pubsub.publisher` for
   `serviceAccount:gmail-api-push@system.gserviceaccount.com`. An organization policy that
   restricts sharing to your domain blocks this; it needs an exception for that account.
3. A **pull subscription** on the topic (no push endpoint), ack deadline 60 s, retention 7 days,
   never expiring.
4. The **subscriber grant** on the subscription: `roles/pubsub.subscriber` for
   `user:<the bot's Google address>`, the account the listener signs in as.

## Meet, by hand

The Workspace Events subscription itself is not a cloud object you make here: `opsbot-google
ensure --source meet` (and the listener) create and renew it with the bot's grant. It needs the
topic in the **same project as the OAuth client** the listener signs in with.

1. A **topic** in that project.
2. **Meet's publisher grant** on it: `roles/pubsub.publisher` for
   `serviceAccount:meet-api-event-push@system.gserviceaccount.com`, the account Google's
   Workspace Events documentation names for Meet events
   ([Create a Google Workspace subscription](https://developers.google.com/workspace/events/guides/create-subscription)).
   A domain-restricted-sharing policy needs an exception for it too.
3. A **pull subscription** on the topic, as for Gmail.
4. The **subscriber grant** for the bot's address, as for Gmail.

`opsbot-google status` then shows the subscription row `ok`. It never creates or changes one.
