# opsbot-google: the cloud objects

An OpenTofu (or Terraform) module for the Pub/Sub objects the Gmail push needs. It has no
backend, no provider settings, no project and no state: call it from your own root module,
which owns those.

```hcl
module "bot_gmail_push" {
  source = "./path/to/opsbot-google/templates/infra" # a copy in your infra repo

  project            = "<your project id>"
  gmail_topic        = "<topic name>"
  gmail_subscription = "<subscription name>"
  gmail_subscriber   = "user:<the bot's Google address>"
}
```

Every input is required. The outputs are the two names to put in `streams.gmail_push`
(`topic`, `subscription`), with `project` and `account` beside them.

Requires the `hashicorp/google` provider 8.x and the Pub/Sub API enabled in the project
(`pubsub.googleapis.com`), plus the Gmail API (`gmail.googleapis.com`) in the project that owns
the OAuth client.

## The same objects by hand

1. A **topic**, e.g. `gcloud pubsub topics create <topic> --project <project>`.
2. **Gmail's publisher grant** on it: `roles/pubsub.publisher` for
   `serviceAccount:gmail-api-push@system.gserviceaccount.com`. An organization policy that
   restricts sharing to your domain blocks this; it needs an exception for that account.
3. A **pull subscription** on the topic (no push endpoint), ack deadline 60 s, retention 7 days,
   never expiring.
4. The **subscriber grant** on the subscription: `roles/pubsub.subscriber` for
   `user:<the bot's Google address>`, the account the listener signs in as.

`opsbot-google status` then shows the subscription row `ok`. It never creates or changes one.
