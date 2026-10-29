// Fill these in from your Google Cloud project (see README.md).
// None of these values are secret: they ship to every browser that loads the app.
// Restrict the API key to your site's origin and to the Google Picker API.
window.IMAGE_MAPPER_CONFIG = {
  // OAuth 2.0 Client ID (type "Web application").
  clientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
  // API key, used only by Google Picker.
  apiKey: 'YOUR_API_KEY',
  // Cloud project *number* (not the project ID). Picker needs it so that files
  // the user picks become readable under the drive.file scope.
  appId: 'YOUR_PROJECT_NUMBER',
};
