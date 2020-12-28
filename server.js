const express = require('express');
const axios = require('axios');
const Path = require('path');
const fs = require('fs');
const config = require('config');
const cors = require('cors');
const multer = require('multer');
const AWS = require('aws-sdk');
const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} = require('@aws-sdk/client-transcribe');

const AWS_REGION = config.get('region');
const AWS_ACCESS_KEY_ID = config.get('awsAccessKeyId');
const AWS_SECREY_KEY = config.get('secretAccessKey');
const AWS_S3_BUCKET_NAME = config.get('s3bucketName');

const upload = multer({ dest: 'uploads/' });

const app = express();
app.use(cors());
app.use(express.json({ extended: false }));

// Initiate an instance of AWS.S3 (connection with AWS S3)
const s3 = new AWS.S3({
  region: AWS_REGION,
  accessKeyId: AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_SECREY_KEY,
});

// Initiate an instance of TranscribeClient (connection with AWS Transribe)
const client = new TranscribeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECREY_KEY,
  },
});

async function downloadJSONFromURL(fileName, s3URL) {
  const url = s3URL;
  const path = Path.resolve(__dirname, '', fileName);
  const writer = fs.createWriteStream(path);

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

const transcribe = async (jobName) => {
  try {
    const data = await client.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
    );
    return data;
  } catch (err) {
    console.log(err);
  }
};

// The HTTP request gets a wav file and convert it to text using AWS Transribe
app.post('/transribe/wav', upload.single('file'), async (req, res) => {
  let s3FileLocation;
  let jobName = 'Job' + Date.now();

  // Check if the file is not .wav extension, if yes, returns error and delete
  if (!req.file.originalname.endsWith('.wav')) {
    fs.unlink(req.file.path, function (err) {
      if (err) throw err;
      console.log('File deleted');
    });
    return res.status(400).send('Only wav extension is supported.');
  }

  // Upload the file to S3
  const fileContent = fs.readFileSync(req.file.path);

  // Setting up S3 upload parameters
  const s3_params = {
    Bucket: AWS_S3_BUCKET_NAME,
    Key: req.file.originalname, // File name you want to save as in S3
    Body: fileContent,
    ACL: 'public-read',
  };

  // Uploading files to the bucket
  s3.upload(s3_params, async function (err, data) {
    if (err) {
      throw err;
    }
    // Set the file location from s3
    s3FileLocation = data.Location.toString().replace('.s3.', '.s3-'); // We need to correct the format as the Transcription service threw an exception of incorrect URI format
    console.log(`S3 File uploaded successfully. ${data.Location}`);

    // After upload to s3, delete from server
    fs.unlink(req.file.path, function (err) {
      if (err) throw err;
      console.log('Local File deleted successfully');
    });

    // Define the params const with a dynamic transcription job name to avoid duplication and errors
    const trans_params = {
      TranscriptionJobName: jobName, // Date.now() makes the job name unique, alternatively we could use gguid or delete every job after use
      LanguageCode: 'en-US',
      MediaFormat: 'wav',
      Media: {
        MediaFileUri: s3FileLocation,
      },
    };

    // Try-catch code block because of await/Promise usage, send a request to start the job for convertion
    try {
      const data = await client.send(
        new StartTranscriptionJobCommand(trans_params)
      );
      console.log(
        'The TranscriptionJobCommand has been successfully progressed'
      );
      // Right now, the job is in progress, we are waiting for it to be completed by intervals of 3 seconds (THIS IS NOT A BEST PRACTICE)
      const jobInterval = setInterval(async () => {
        const transcribe_response = await transcribe(jobName);
        console.log(
          transcribe_response.TranscriptionJob.TranscriptionJobStatus
        );
        // If the job is completed, read the response, stop the interval and delete from S3
        if (
          transcribe_response.TranscriptionJob.TranscriptionJobStatus ===
          'COMPLETED'
        ) {
          // Delete the file from S3 (Only when completed)
          s3.deleteObject(
            { Bucket: s3_params.Bucket, Key: s3_params.Key },
            function (err, data) {
              if (err) throw err;
              console.log('S3 File deleted successfully');
            }
          );

          // Download the JSON file from the given URL to the server so we will be able to read the JSON after
          let fileName = `job_response_${jobName}.json`;
          let json_response = await downloadJSONFromURL(
            fileName,
            transcribe_response.TranscriptionJob.Transcript.TranscriptFileUri
          );

          // Read the JSON file and parse to transcribe_completed_response object
          let jsonData = fs.readFileSync(fileName);
          let transcribe_completed_response = JSON.parse(jsonData);

          // Delete the JSON
          fs.unlink(fileName, function (err) {
            if (err) throw err;
            console.log('JSON Local File deleted successfully');
          });

          // Delete the Job - ?

          // Delete the Transcription job from AWS
          res.send(
            transcribe_completed_response.results.transcripts[0].transcript
          );
          clearInterval(jobInterval);
        }
      }, 10000);
    } catch (err) {
      // If fails, delete the file from S3
      return res
        .status(400)
        .send(
          'There is an error while trying to convert using Transcription: ' +
            err
        );
    }
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on ${PORT}`));
