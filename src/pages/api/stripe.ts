// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from "next";

import { JWT } from "google-auth-library";
import { google } from "googleapis";
import Stripe from "stripe";
import { buffer } from "micro";

const EMAIL_COLUMN_NUMBER = 1;

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
    range: "Sheet1!A:A",
  };
  const response = await sheets.spreadsheets.values.get(request);
  const values = response.data.values;
  if (values) {
    return values.some((row: any) => row[0] === email);
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
    range: "Sheet1!A:E",
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
          values: [["", "", "", "", "", ""]], // this should be the same length as the array in appendTOGoogleSheet to delete all data
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
      "",
      date,
      new Date().toISOString(),
    ]}`
  );
  const request = {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    resource: {
      values: [[subId, email, name, "", date, new Date().toISOString()]], // important to set EMAIL_COLUMN_NUMBER to the correct column according to this
      // values: [["test2@email.com", "test", "2021-12-31T23:59:59.999Z"]],
    },
  };
  const response = await sheets.spreadsheets.values.append(request);
  console.log({ response });
  console.log(`Wrote email, name and date to Google Sheet: ${email}`);
};

const getCustomerNameFromStripe = async (customerId: string) => {
  console.log(`Getting customer name, customerId: ${customerId}`);
  const customer = await stripe.customers.retrieve(customerId);
  return (customer as any).name;
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
    console.log(`Received event: ${event.type}`);
    const emailAlreadyThere = await checkIfGoogleSheetColumnContainsEmail(
      customerEmail,
      sheets
    );
    console.info(`Email ${customerEmail} already there: `, emailAlreadyThere);
    if (!emailAlreadyThere) {
      const name = await getCustomerNameFromStripe(object.customer);
      appendToGoogleSheet(
        object.id,
        customerEmail,
        name,
        new Date(object.created * 1000).toISOString(),
        sheets
      );
      console.log(`Wrote email to Google Sheet: ${customerEmail}`);

      res.statusCode = 200;
      res.end(`Wrote email to Google Sheet: ${customerEmail}`);
      console.log(`Email already in Google Sheet: ${customerEmail}`);
    } else {
      res.statusCode = 200;
      res.end(`Email already in Google Sheet: ${customerEmail}`);
    }
  }

  if (event.type === "customer.subscription.updated") {
    res.statusCode = 200;
    res.end(`We don't process customer.subscription.updated events right now`);
  }

  if (event.type === "customer.subscription.deleted") {
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
