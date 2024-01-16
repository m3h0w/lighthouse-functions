// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from "next";

import { JWT } from "google-auth-library";
import { google } from "googleapis";
import Stripe from "stripe";
import { buffer } from "micro";

const EMAIL_COLUMN_NUMBER = 1;
const EMAIL_COLUMN_LETTER = "B";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2022-11-15",
});

const getEmailBasedOnCustomerId = async (customerId: string) => {
  const customer = await stripe.customers.retrieve(customerId);
  return (customer as any).email;
};

const checkIfGoogleSheetColumnContainsEmail = async (
  email: string,
  sheets: any
) => {
  console.log(`Checking if Google Sheet contains email: ${email}`);
  const request = {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!${EMAIL_COLUMN_LETTER}:${EMAIL_COLUMN_LETTER}`,
  };
  const response = await sheets.spreadsheets.values.get(request);
  const values = response.data.values as any[][];
  if (values) {
    return values.flat().some((v: any) => v === email);
  } else {
    return false;
  }
};

const deleteEmailFromGoogleSheet = async (email: string, sheets: any) => {
  const request = {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A:A",
  };
  const response = await sheets.spreadsheets.values.get(request);
  const values = response.data.values;
  if (values) {
    const index = values.findIndex((row: any) => row[0] === email);
    if (index > -1) {
      const request = {
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Sheet1!A${index + 1}:A${index + 1}`,
        valueInputOption: "RAW",
        resource: {
          values: [[""]],
        },
      };
      const response = await sheets.spreadsheets.values.update(request);
      console.log({ response });
      console.log(`Deleted email from Google Sheet: ${email}`);
    }
  }
};

const deleteRowContainingEmailFromGoogleSheet = async (
  email: string,
  sheets: any
) => {
  console.log(`Deleting email from Google Sheet: ${email}`);
  const request = {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A:F",
  };
  const response = await sheets.spreadsheets.values.get(request);
  const values = response.data.values;
  if (values) {
    const index = values.findIndex(
      (row: any) => row[EMAIL_COLUMN_NUMBER] === email
    );
    if (index > -1) {
      const request = {
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Sheet1!A${index + 1}:E${index + 1}`,
        valueInputOption: "RAW",
        resource: {
          values: [["", "", "", "", ""]], // this should be the same length as the array in appendTOGoogleSheet to delete all data
        },
      };
      const response = await sheets.spreadsheets.values.update(request);
      console.log({ response });
      console.log(`Deleted email from Google Sheet: ${email}`);
    } else {
      console.log(`Email not found in Google Sheet: ${email}`);
    }
  }
};

const appendRowBelowLastRow = async (sheets: any) => {
  const request = {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    resource: {
      values: [[""]],
    },
  };

  const response = await sheets.spreadsheets.values.append(request);
  console.log({ response });
};

const appendToGoogleSheet = async (
  subId: string,
  email: string,
  name: string,
  date: string,
  sheets: any
) => {
  console.log(
    `Appending to Google Sheet: ${[
      subId,
      email,
      name,
      date,
      new Date().toISOString(),
    ]}`
  );
  const request = {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    resource: {
      values: [[subId, email, name, date, new Date().toISOString()]], // important to set EMAIL_COLUMN_NUMBER to the correct column according to this
      // values: [["test2@email.com", "test", "2021-12-31T23:59:59.999Z"]],
    },
  };
  const response = await sheets.spreadsheets.values.append(request);
  console.log({ response });
  console.log(`Wrote email, name and date to Google Sheet: ${email}`);
  return response;
};

const getCustomerNameFromStripe = async (customerId: string) => {
  console.log(`Getting customer name, customerId: ${customerId}`);
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) {
    throw new Error("Customer deleted");
  }
  return customer.name ?? customer.description ?? "-";
};

const checkIfCustomerHasActiveSubscription = async (customerId: string) => {
  console.log(
    `Checking if customer has active subscription, customerId: ${customerId}`
  );
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "active",
  });
  return subscriptions.data.length > 0;
};

const checkIfCustomerHasActiveSubscriptionEmail = async (email: string) => {
  console.log(`Checking if customer has active subscription, email: ${email}`);
  const customers = await stripe.customers.list({
    email,
  });
  if (customers.data.length === 0) {
    console.log(`Customer not found, email: ${email}`);
    return false;
  }
  for (const customer of customers.data) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: "active",
    });
    if (subscriptions.data.length > 0) {
      return true;
    }
  }
  return false;
};

const handleStripeSubscriptionUpdate = async (
  req: NextApiRequest,
  res: NextApiResponse
) => {
  console.info("Sheet ID: ", process.env.GOOGLE_SHEET_ID);

  // Verify the webhook signature
  const rawBody = await buffer(req);
  const stripeSignature = req.headers["stripe-signature"];
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      stripeSignature!,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.log(`Error: ${err.message}`);
    res.statusCode = 400;
    res.end(`Webhook Error: ${err.message}`);
    return;
  }

  if (
    event.type !== "customer.subscription.created" &&
    event.type !== "customer.subscription.updated" &&
    event.type !== "customer.subscription.deleted"
  ) {
    res.statusCode = 500;
    res.end(`Webhook Error: Unexpected event type: ${event.type}`);
    return;
  }

  const object = event.data.object as any;
  const customerEmail =
    object.email ?? object.customer_email ?? object.customer
      ? await getEmailBasedOnCustomerId(object.customer)
      : null;

  console.log(`Received event: ${event.type}`);
  console.info("Received object data: ", object);

  // Authenticate with Google using a service account
  const jwtClient = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: Buffer.from(process.env.GOOGLE_PRIVATE_KEY!, "base64")
      .toString("ascii")
      .replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  // Get a Google Sheets API client
  const sheets = google.sheets({ version: "v4", auth: jwtClient });

  if (event.type === "customer.subscription.created") {
    const hasActiveSubscription = await checkIfCustomerHasActiveSubscription(
      object.customer
    );
    const emailAlreadyThere = await checkIfGoogleSheetColumnContainsEmail(
      customerEmail,
      sheets
    );
    console.info(`Email ${customerEmail} already there: `, emailAlreadyThere);
    if (!emailAlreadyThere && hasActiveSubscription) {
      const name = await getCustomerNameFromStripe(object.customer);
      const response = await appendToGoogleSheet(
        object.id,
        customerEmail,
        name,
        object.created
          ? new Date(object.created * 1000).toISOString()
          : new Date().toISOString(),
        sheets
      );
      // console.log(`Wrote email to Google Sheet: ${customerEmail}`);

      res.statusCode = 200;
      res.end(`Wrote email to Google Sheet: ${customerEmail}, ${response}`);
    } else {
      res.statusCode = 200;
      res.end(`Email already in Google Sheet: ${customerEmail}`);
    }
  }

  if (event.type === "customer.subscription.updated") {
    const idHasActiveSubscription = await checkIfCustomerHasActiveSubscription(
      object.customer
    );
    // there might be multiple customers with the same email and if one of them deletes their subscription,
    // we don't want to delete the email from the Google Sheet if they have a subcription on another customer id
    const hasActiveSubscription =
      idHasActiveSubscription ||
      (await checkIfCustomerHasActiveSubscriptionEmail(customerEmail));

    const emailAlreadyThere = await checkIfGoogleSheetColumnContainsEmail(
      customerEmail,
      sheets
    );
    console.info(`Email ${customerEmail} already there: `, emailAlreadyThere);

    if (hasActiveSubscription) {
      if (!emailAlreadyThere) {
        const name = await getCustomerNameFromStripe(object.customer);
        const response = await appendToGoogleSheet(
          object.id,
          customerEmail,
          name,
          object.created
            ? new Date(object.created * 1000).toISOString()
            : new Date().toISOString(),
          sheets
        );
        // console.log(`Wrote email to Google Sheet: ${customerEmail}`);

        res.statusCode = 200;
        res.end(
          `Subscription update & active susbscription found. Wrote email to Google Sheet: ${customerEmail}, ${response}`
        );
      } else {
        res.statusCode = 200;
        res.end(
          `Subscription update & active susbscription found. Email already in Google Sheet: ${customerEmail}`
        );
      }
    }

    if (!hasActiveSubscription) {
      if (emailAlreadyThere) {
        await deleteRowContainingEmailFromGoogleSheet(customerEmail, sheets);
        res.statusCode = 200;
        res.end(
          `Subscription updated & no active subscription found. Deleted email from Google Sheet: ${customerEmail}`
        );
      } else {
        res.statusCode = 200;
        res.end(
          `Subscription updated & no active subscription found. Email not in Google Sheet: ${customerEmail}`
        );
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    if (await checkIfCustomerHasActiveSubscription(object.customer)) {
      res.statusCode = 200;
      res.end(
        `Customer has active subscription, not deleting email from Google Sheet: ${customerEmail}`
      );
      return;
    }
    await deleteRowContainingEmailFromGoogleSheet(customerEmail, sheets);
    res.statusCode = 200;
    res.end(`Deleted email from Google Sheet: ${customerEmail}`);
  }

  console.log("event:", event.type);
};

export default handleStripeSubscriptionUpdate;

export const config = {
  api: {
    bodyParser: false,
  },
};
